const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "community.multi.stream",
    version: "4.0.1",
    name: "Djanki Movies",
    description: "Just trust me bro, I am albanian virus lol",
    types: ["movie", "series"],
    resources: ["stream"],
    catalogs: [],
    idPrefixes: ["tt"]
};
const builder = new addonBuilder(manifest);

const MAX_RESULTS = 20;
const TIMEOUT = 8000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

// Domains change over time; tried in order, first one that answers wins.
const YTS_HOSTS = (process.env.YTS_HOSTS || "https://yts.mx").split(",");
const EZTV_HOSTS = (process.env.EZTV_HOSTS || "https://eztv.re,https://eztv.wf,https://eztvx.to").split(",");
const APIBAY = "https://apibay.org/q.php";

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce"
].map(t => "tracker:" + t);

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

function http(url, params) {
    return axios.get(url, {
        params,
        timeout: TIMEOUT,
        headers: { "User-Agent": UA },
        validateStatus: () => true
    });
}

function formatSize(bytes) {
    const n = Number(bytes);
    if (!n) return "";
    const gb = n / 1024 ** 3;
    return gb >= 1 ? gb.toFixed(2) + " GB" : (n / 1024 ** 2).toFixed(0) + " MB";
}

async function getMeta(type, imdbId) {
    try {
        const baseId = imdbId.split(":")[0];
        const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`, { timeout: TIMEOUT });
        const meta = r.data.meta;
        if (!meta) return null;
        const year = (meta.year || meta.releaseInfo || "").toString().match(/\d{4}/);
        return { name: meta.name, year: year ? year[0] : null };
    } catch (e) {
        console.error("Meta lookup error:", e.message);
        return null;
    }
}

// ---------- Sources: each returns [{ hash, label, seeds, size, source }] ----------

async function fromYts(imdbId) {
    for (const host of YTS_HOSTS) {
        const r = await http(`${host}/api/v2/list_movies.json`, { query_term: imdbId });
        const movies = r.data && r.data.data && r.data.data.movies;
        console.log(`YTS ${host} -> HTTP ${r.status}, movies: ${movies ? movies.length : 0}`);
        if (r.status !== 200 || typeof r.data !== "object") continue;
        const out = [];
        for (const m of movies || []) {
            for (const t of m.torrents || []) {
                out.push({
                    hash: t.hash,
                    label: `${m.title_long} ${t.quality} ${t.type || ""}`.trim(),
                    seeds: t.seeds,
                    size: t.size_bytes,
                    source: "YTS"
                });
            }
        }
        return out;
    }
    return [];
}

async function fromEztv(imdbId, season, episode) {
    const numeric = imdbId.replace(/\D/g, "");
    for (const host of EZTV_HOSTS) {
        const r = await http(`${host}/api/get-torrents`, { imdb_id: numeric, limit: 100, page: 1 });
        const list = r.data && r.data.torrents;
        console.log(`EZTV ${host} -> HTTP ${r.status}, torrents: ${list ? list.length : 0}`);
        if (r.status !== 200 || typeof r.data !== "object") continue;
        return (list || [])
            .filter(t => Number(t.season) === Number(season) && Number(t.episode) === Number(episode))
            .map(t => ({
                hash: t.hash,
                label: t.title || t.filename,
                seeds: t.seeds,
                size: t.size_bytes,
                source: "EZTV"
            }));
    }
    return [];
}

async function fromApibay(query, wantedCats) {
    const r = await http(APIBAY, { q: query, cat: 0 });
    const ok = Array.isArray(r.data);
    console.log(`TPB "${query}" -> HTTP ${r.status}, ${ok ? r.data.length + " rows" : "not JSON (blocked?)"}`);
    if (!ok) return [];
    return r.data
        .filter(x => x.info_hash && !/^0+$/.test(x.info_hash) && wantedCats.has(String(x.category)))
        .map(x => ({
            hash: x.info_hash,
            label: x.name,
            seeds: x.seeders,
            size: x.size,
            source: "TPB"
        }));
}

const MOVIE_CATS = new Set(["201", "202", "207", "209"]);
const TV_CATS = new Set(["205", "208"]);

// ---------- Combine ----------

async function findStreams(type, id, meta) {
    const key = type + ":" + id;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < CACHE_MS) return cached.streams;

    const imdbId = id.split(":")[0];
    let jobs;
    if (type === "movie") {
        jobs = [
            fromYts(imdbId),
            fromApibay(meta.year ? `${meta.name} ${meta.year}` : meta.name, MOVIE_CATS)
        ];
    } else {
        const [, season, episode] = id.split(":");
        const s = String(season).padStart(2, "0");
        const e = String(episode).padStart(2, "0");
        jobs = [
            fromEztv(imdbId, season, episode),
            fromApibay(`${meta.name} S${s}E${e}`, TV_CATS)
        ];
    }

    const settled = await Promise.allSettled(jobs);
    const items = [];
    settled.forEach(s => {
        if (s.status === "fulfilled") items.push(...s.value);
        else console.error("Source error:", s.reason && s.reason.message);
    });

    const seen = new Set();
    const streams = items
        .filter(x => x.hash && Number(x.seeds) >= 1)
        .sort((a, b) => Number(b.seeds) - Number(a.seeds))
        .filter(x => {
            const h = x.hash.toLowerCase();
            if (seen.has(h)) return false;
            seen.add(h);
            return true;
        })
        .slice(0, MAX_RESULTS)
        .map(x => ({
            name: `🧲 ${x.source}`,
            title: `${x.label}\n👤 ${x.seeds}  💾 ${formatSize(x.size)}`,
            infoHash: x.hash.toLowerCase(),
            sources: TRACKERS
        }));

    if (streams.length) cache.set(key, { time: Date.now(), streams });
    return streams;
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie" && type !== "series") return { streams: [] };

    const meta = await getMeta(type, id);
    console.log("Stream request:", type, id, "->", meta && meta.name, meta && meta.year);
    if (!meta) return { streams: [] };

    const streams = await findStreams(type, id, meta);
    console.log("Found", streams.length, "streams");
    return { streams };
});

module.exports = builder.getInterface();

if (require.main === module) {
    serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
}
