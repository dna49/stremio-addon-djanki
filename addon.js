const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "community.tpb.stream",
    version: "3.0.0",
    name: "TPB Streams",
    description: "Torrent streams for movies and series from The Pirate Bay (apibay.org)",
    types: ["movie", "series"],
    resources: ["stream"],
    catalogs: [],
    idPrefixes: ["tt"]
};
const builder = new addonBuilder(manifest);

const API = "https://apibay.org/q.php";
const MAX_RESULTS = 15;
const MIN_SEEDERS = 1;
const NO_RESULT_HASH = "0000000000000000000000000000000000000000";

// apibay category ids: 201 movies, 207 HD movies, 205 TV, 208 HD TV
const MOVIE_CATS = new Set(["201", "202", "207", "209"]);
const TV_CATS = new Set(["205", "208"]);

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce"
].map(t => "tracker:" + t);

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

async function getMeta(type, imdbId) {
    try {
        const baseId = imdbId.split(":")[0];
        const response = await axios.get(
            `https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`
        );
        const meta = response.data.meta;
        if (!meta) return null;
        const year = (meta.year || meta.releaseInfo || "").toString().match(/\d{4}/);
        return { name: meta.name, year: year ? year[0] : null };
    } catch (error) {
        console.error("Meta lookup error:", error.message);
        return null;
    }
}

function formatSize(bytes) {
    const n = Number(bytes);
    if (!n) return "";
    const gb = n / 1024 ** 3;
    return gb >= 1 ? gb.toFixed(2) + " GB" : (n / 1024 ** 2).toFixed(0) + " MB";
}

async function searchApibay(query) {
    const response = await axios.get(API, { params: { q: query, cat: 0 }, timeout: 10000 });
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.filter(r => r.info_hash && r.info_hash !== NO_RESULT_HASH);
}

function toStreams(rows, wantedCats) {
    const seen = new Set();
    return rows
        .filter(r => wantedCats.has(String(r.category)))
        .filter(r => Number(r.seeders) >= MIN_SEEDERS)
        .sort((a, b) => Number(b.seeders) - Number(a.seeders))
        .filter(r => {
            const h = r.info_hash.toLowerCase();
            if (seen.has(h)) return false;
            seen.add(h);
            return true;
        })
        .slice(0, MAX_RESULTS)
        .map(r => ({
            name: "🏴‍☠️ TPB",
            title: `${r.name}\n👤 ${r.seeders}  💾 ${formatSize(r.size)}`,
            infoHash: r.info_hash.toLowerCase(),
            sources: TRACKERS
        }));
}

async function findStreams(type, id, meta) {
    const key = type + ":" + id;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < CACHE_MS) return cached.streams;

    let streams = [];
    try {
        if (type === "movie") {
            let rows = meta.year ? await searchApibay(`${meta.name} ${meta.year}`) : [];
            if (!rows.length) rows = await searchApibay(meta.name);
            streams = toStreams(rows, MOVIE_CATS);
        } else {
            const [, season, episode] = id.split(":");
            const s = String(season).padStart(2, "0");
            const e = String(episode).padStart(2, "0");
            const rows = await searchApibay(`${meta.name} S${s}E${e}`);
            streams = toStreams(rows, TV_CATS);
        }
    } catch (error) {
        console.error("Search error:", error.message);
        return [];
    }

    cache.set(key, { time: Date.now(), streams });
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
