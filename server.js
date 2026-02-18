const path = require("path");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const GRID_SIZE_METERS = 50;
const MIN_RADIUS_METERS = Number(process.env.MIN_RADIUS_METERS || 300);
const MAX_RADIUS_METERS = Number(process.env.MAX_RADIUS_METERS || 1000);
const MAX_TRANSIT_SAMPLES = Number(process.env.MAX_TRANSIT_SAMPLES || 90);
const TRANSIT_CONCURRENCY = Number(process.env.TRANSIT_CONCURRENCY || 5);
const WALKING_SPEED_KMH = Number(process.env.WALKING_SPEED_KMH || 4.5);
const WALKING_SPEED_M_PER_MIN = (WALKING_SPEED_KMH * 1000) / 60;
const WALK_DETOUR_FACTOR = Number(process.env.WALK_DETOUR_FACTOR || 1.22);
const MAX_TRANSFER_WALK_METERS = Number(process.env.MAX_TRANSFER_WALK_METERS || 500);
const TRANSIT_TIMEOUT_MS = Number(process.env.TRANSIT_TIMEOUT_MS || 10000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX_SIZE = Number(process.env.CACHE_MAX_SIZE || 5000);
const ODSAY_BASE_URL = "https://api.odsay.com/v1/api/searchPubTransPathT";

const routeCache = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({
    kakaoJsKey: process.env.KAKAO_JS_KEY || "",
    gridSizeMeters: GRID_SIZE_METERS,
    minRadiusMeters: MIN_RADIUS_METERS,
    maxRadiusMeters: MAX_RADIUS_METERS,
    transitEnabled: Boolean(process.env.ODSAY_API_KEY),
  });
});

app.post("/api/isochrone", async (req, res) => {
  try {
    const payload = validatePayload(req.body);
    const result = await buildIsochrone(payload);
    res.json(result);
  } catch (error) {
    const statusCode = error.statusCode || 400;
    res.status(statusCode).json({
      error: error.message || "요청을 처리하지 못했습니다.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

function validatePayload(body) {
  if (!body || typeof body !== "object") {
    throw createError(400, "요청 본문이 비어 있습니다.");
  }

  const origin = body.origin || {};
  const lat = Number(origin.lat);
  const lng = Number(origin.lng);

  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    throw createError(400, "출발지 좌표가 올바르지 않습니다.");
  }

  const radiusMeters = clamp(
    Number(body.radiusMeters || 800),
    MIN_RADIUS_METERS,
    MAX_RADIUS_METERS
  );

  const maxMinutes = clamp(Number(body.maxMinutes || 90), 20, 180);
  const departureMode = body.departureMode === "custom" ? "custom" : "now";
  const dayType = normalizeDayType(body.dayType);
  const time = normalizeTime(body.time || "08:30");
  const waitMultiplier = deriveWaitMultiplier(departureMode, dayType, time);

  return {
    origin: { lat, lng },
    radiusMeters,
    maxMinutes,
    departureMode,
    dayType,
    time,
    waitMultiplier,
  };
}

async function buildIsochrone(payload) {
  const { origin, radiusMeters, maxMinutes, departureMode, dayType, time, waitMultiplier } = payload;
  const gridCells = generateGrid(origin, radiusMeters, GRID_SIZE_METERS);
  const sampledCells = pickSampleCells(gridCells, MAX_TRANSIT_SAMPLES);

  const notes = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let apiFailures = 0;

  const transitEnabled = Boolean(process.env.ODSAY_API_KEY);
  if (!transitEnabled) {
    notes.push("ODSAY_API_KEY가 없어 대중교통 계산 없이 도보 기준으로만 표시합니다.");
  }

  const sampledTransitTimes = await runWithConcurrency(
    sampledCells,
    TRANSIT_CONCURRENCY,
    async (cell) => {
      if (!transitEnabled) {
        return { ...cell, transitMinutes: Number.POSITIVE_INFINITY };
      }

      const route = await fetchTransitRoute({
        origin,
        destination: { lat: cell.lat, lng: cell.lng },
        dayType,
        time,
      });

      if (route.cache === "hit") {
        cacheHits += 1;
      } else {
        cacheMisses += 1;
      }

      if (!route.ok) {
        if (route.reason !== "too_close") {
          apiFailures += 1;
        }
        return { ...cell, transitMinutes: Number.POSITIVE_INFINITY };
      }

      const adjustedMinutes =
        route.baseMinutes + route.totalIntervalMinutes * 0.5 * waitMultiplier;

      return {
        ...cell,
        transitMinutes: adjustedMinutes,
      };
    }
  );

  const validTransitSamples = sampledTransitTimes.filter((cell) =>
    Number.isFinite(cell.transitMinutes)
  );

  const cells = gridCells.map((cell) => {
    const walkDistanceMeters = Math.hypot(cell.eastMeters, cell.northMeters);
    const walkMinutes = (walkDistanceMeters * WALK_DETOUR_FACTOR) / WALKING_SPEED_M_PER_MIN;
    const transitMinutes = interpolateTransit(cell, validTransitSamples);
    const minutes = Math.min(walkMinutes, transitMinutes);
    const mode = minutes === walkMinutes ? "walk" : "transit";

    return {
      lat: roundTo(cell.lat, 7),
      lng: roundTo(cell.lng, 7),
      sw: {
        lat: roundTo(cell.sw.lat, 7),
        lng: roundTo(cell.sw.lng, 7),
      },
      ne: {
        lat: roundTo(cell.ne.lat, 7),
        lng: roundTo(cell.ne.lng, 7),
      },
      minutes: roundTo(minutes, 2),
      mode,
    };
  });

  return {
    settings: {
      gridSizeMeters: GRID_SIZE_METERS,
      radiusMeters,
      maxMinutes,
      maxTransferWalkMeters: MAX_TRANSFER_WALK_METERS,
      departureMode,
      dayType,
      time,
      waitMultiplier: roundTo(waitMultiplier, 2),
      transitEnabled,
    },
    stats: {
      totalGridCells: gridCells.length,
      sampledTransitCells: sampledCells.length,
      validTransitSamples: validTransitSamples.length,
      cacheHits,
      cacheMisses,
      apiFailures,
      notes,
    },
    cells,
  };
}

function generateGrid(origin, radiusMeters, stepMeters) {
  const halfCellMeters = stepMeters / 2;
  const maxIndex = Math.floor(radiusMeters / stepMeters);
  const cells = [];

  for (let northIndex = -maxIndex; northIndex <= maxIndex; northIndex += 1) {
    for (let eastIndex = -maxIndex; eastIndex <= maxIndex; eastIndex += 1) {
      const northMeters = northIndex * stepMeters;
      const eastMeters = eastIndex * stepMeters;
      const radialDistance = Math.hypot(northMeters, eastMeters);
      if (radialDistance > radiusMeters) {
        continue;
      }

      const center = offsetLatLng(origin, eastMeters, northMeters);
      const southWest = offsetLatLng(center, -halfCellMeters, -halfCellMeters);
      const northEast = offsetLatLng(center, halfCellMeters, halfCellMeters);

      cells.push({
        id: `${eastMeters}:${northMeters}`,
        eastIndex,
        northIndex,
        eastMeters,
        northMeters,
        lat: center.lat,
        lng: center.lng,
        sw: southWest,
        ne: northEast,
      });
    }
  }

  return cells;
}

function pickSampleCells(cells, maxSamples) {
  if (cells.length <= maxSamples) {
    return cells;
  }

  const stride = Math.max(1, Math.ceil(Math.sqrt(cells.length / maxSamples)));
  const sampled = cells.filter(
    (cell) =>
      Math.abs(cell.eastIndex) % stride === 0 &&
      Math.abs(cell.northIndex) % stride === 0
  );

  const hasCenter = sampled.some((cell) => cell.eastIndex === 0 && cell.northIndex === 0);
  if (!hasCenter) {
    const center = cells.find((cell) => cell.eastIndex === 0 && cell.northIndex === 0);
    if (center) {
      sampled.push(center);
    }
  }

  return sampled.slice(0, maxSamples);
}

async function fetchTransitRoute({ origin, destination, dayType, time }) {
  const cacheKey = buildCacheKey(origin, destination, dayType, time);
  const cached = getCachedRoute(cacheKey);
  if (cached) {
    return { ...cached, cache: "hit" };
  }

  const result = await queryOdsay(origin, destination);
  setCachedRoute(cacheKey, result);
  return { ...result, cache: "miss" };
}

async function queryOdsay(origin, destination) {
  const apiKey = process.env.ODSAY_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "missing_key" };
  }

  const params = new URLSearchParams({
    SX: String(origin.lng),
    SY: String(origin.lat),
    EX: String(destination.lng),
    EY: String(destination.lat),
    SearchType: "0",
    SearchPathType: "0",
    OPT: "0",
    apiKey,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRANSIT_TIMEOUT_MS);

  try {
    const response = await fetch(`${ODSAY_BASE_URL}?${params.toString()}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }

    const json = await response.json();
    if (json.error) {
      const code = Number(json.error.code);
      if (code === -98) {
        return { ok: false, reason: "too_close" };
      }
      if (code === -99) {
        return { ok: false, reason: "no_path" };
      }
      return { ok: false, reason: json.error.msg || "odsay_error" };
    }

    return extractBestPath(json.result || {});
  } catch (error) {
    if (error.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network_error" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractBestPath(result) {
  const searchType = toNumber(result.searchType);
  if (isFiniteNumber(searchType) && searchType !== 0) {
    return { ok: false, reason: "outside_city_network" };
  }

  const paths = Array.isArray(result.path) ? result.path : [];
  let best = null;

  for (const path of paths) {
    const pathType = toNumber(path.pathType);
    if (isFiniteNumber(pathType) && ![1, 2, 3].includes(pathType)) {
      continue;
    }

    if (hasExcludedTransit(path.subPath)) {
      continue;
    }

    const totalWalk = toNumber(path.info?.totalWalk);
    if (isFiniteNumber(totalWalk) && totalWalk > MAX_TRANSFER_WALK_METERS) {
      continue;
    }

    if (containsLongWalkSection(path.subPath)) {
      continue;
    }

    const baseMinutes = readBaseMinutes(path);
    if (!isFiniteNumber(baseMinutes)) {
      continue;
    }

    const totalIntervalMinutes = readIntervalMinutes(path);
    const candidate = {
      ok: true,
      baseMinutes,
      totalIntervalMinutes: totalIntervalMinutes > 0 ? totalIntervalMinutes : 0,
    };

    if (!best || candidate.baseMinutes + candidate.totalIntervalMinutes * 0.5 < best.baseMinutes + best.totalIntervalMinutes * 0.5) {
      best = candidate;
    }
  }

  if (!best) {
    return { ok: false, reason: "no_valid_path" };
  }

  return best;
}

function hasExcludedTransit(subPath) {
  const segments = Array.isArray(subPath) ? subPath : [];
  for (const segment of segments) {
    const trafficType = Number(segment.trafficType);
    if ([4, 5, 6, 7].includes(trafficType)) {
      return true;
    }
  }
  return false;
}

function containsLongWalkSection(subPath) {
  const segments = Array.isArray(subPath) ? subPath : [];
  for (const segment of segments) {
    if (Number(segment.trafficType) !== 3) {
      continue;
    }
    const distance = toNumber(segment.distance);
    if (isFiniteNumber(distance) && distance > MAX_TRANSFER_WALK_METERS) {
      return true;
    }
  }
  return false;
}

function readBaseMinutes(path) {
  const infoMinutes = toNumber(path.info?.totalTime);
  if (isFiniteNumber(infoMinutes)) {
    return infoMinutes;
  }

  const segments = Array.isArray(path.subPath) ? path.subPath : [];
  let total = 0;
  let found = false;
  for (const segment of segments) {
    const sectionTime = toNumber(segment.sectionTime);
    if (isFiniteNumber(sectionTime)) {
      total += sectionTime;
      found = true;
    }
  }
  return found ? total : Number.NaN;
}

function readIntervalMinutes(path) {
  const infoInterval = toNumber(path.info?.totalIntervalTime);
  if (isFiniteNumber(infoInterval) && infoInterval > 0) {
    return infoInterval;
  }

  const segments = Array.isArray(path.subPath) ? path.subPath : [];
  let total = 0;

  for (const segment of segments) {
    const trafficType = Number(segment.trafficType);
    if (![1, 2].includes(trafficType)) {
      continue;
    }

    let interval = toNumber(segment.intervalTime);
    if (!isFiniteNumber(interval) || interval <= 0) {
      interval = readLaneInterval(segment.lane);
    }

    if (isFiniteNumber(interval) && interval > 0) {
      total += interval;
    }
  }

  return total;
}

function readLaneInterval(lanes) {
  if (!Array.isArray(lanes)) {
    return Number.NaN;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const lane of lanes) {
    const interval = toNumber(lane?.intervalTime);
    if (isFiniteNumber(interval) && interval > 0 && interval < best) {
      best = interval;
    }
  }
  return Number.isFinite(best) ? best : Number.NaN;
}

function interpolateTransit(cell, sampleCells) {
  if (!sampleCells.length) {
    return Number.POSITIVE_INFINITY;
  }

  const nearest = [];
  for (const sample of sampleCells) {
    const distanceMeters = Math.hypot(
      sample.eastMeters - cell.eastMeters,
      sample.northMeters - cell.northMeters
    );
    if (distanceMeters < 1) {
      return sample.transitMinutes;
    }
    const lastMileWalkMinutes = (distanceMeters * WALK_DETOUR_FACTOR) / WALKING_SPEED_M_PER_MIN;
    nearest.push({
      distanceMeters,
      transitMinutes: sample.transitMinutes + lastMileWalkMinutes,
    });
  }

  nearest.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const top = nearest.slice(0, 4);
  let weightedTime = 0;
  let totalWeight = 0;

  for (const item of top) {
    const weight = 1 / (item.distanceMeters * item.distanceMeters);
    weightedTime += item.transitMinutes * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return weightedTime / totalWeight;
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let index = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        break;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function buildCacheKey(origin, destination, dayType, time) {
  return [
    roundTo(origin.lat, 5),
    roundTo(origin.lng, 5),
    roundTo(destination.lat, 5),
    roundTo(destination.lng, 5),
    dayType,
    time,
  ].join("|");
}

function getCachedRoute(key) {
  const entry = routeCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    routeCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedRoute(key, value) {
  routeCache.set(key, {
    value,
    createdAt: Date.now(),
  });

  if (routeCache.size <= CACHE_MAX_SIZE) {
    return;
  }
  const oldestKey = routeCache.keys().next().value;
  if (oldestKey) {
    routeCache.delete(oldestKey);
  }
}

function offsetLatLng(origin, eastMeters, northMeters) {
  const latDelta = northMeters / 111320;
  const lngDelta = eastMeters / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return {
    lat: origin.lat + latDelta,
    lng: origin.lng + lngDelta,
  };
}

function normalizeDayType(value) {
  if (value === "saturday" || value === "sunday") {
    return value;
  }
  return "weekday";
}

function normalizeTime(value) {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  if (!matched) {
    return "08:30";
  }
  return `${matched[1]}:${matched[2]}`;
}

function deriveWaitMultiplier(departureMode, dayType, time) {
  let baseDay = dayType;
  let baseTime = time;

  if (departureMode === "now") {
    const now = new Date();
    const day = now.getDay();
    baseDay = day === 0 ? "sunday" : day === 6 ? "saturday" : "weekday";
    baseTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  const [hourText] = baseTime.split(":");
  const hour = Number(hourText);

  let multiplier = 1;
  if (baseDay === "saturday") {
    multiplier *= 1.08;
  }
  if (baseDay === "sunday") {
    multiplier *= 1.12;
  }
  if (baseDay === "weekday" && ((hour >= 7 && hour < 9) || (hour >= 17 && hour < 20))) {
    multiplier *= 0.9;
  }
  if (hour >= 23 || hour < 5) {
    multiplier *= 1.25;
  }

  return multiplier;
}

function clamp(value, min, max) {
  if (!isFiniteNumber(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
