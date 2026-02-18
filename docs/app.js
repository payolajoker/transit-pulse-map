const DEFAULT_ORIGIN = {
  name: "판교역",
  lat: 37.3947384,
  lng: 127.1111955,
};

const GRID_SIZE_METERS = 50;
const MIN_RADIUS_METERS = 300;
const MAX_RADIUS_METERS = 1000;
const MAX_TRANSIT_SAMPLES = 90;
const TRANSIT_CONCURRENCY = 5;
const WALKING_SPEED_KMH = 4.5;
const WALK_DETOUR_FACTOR = 1.22;
const WALKING_SPEED_M_PER_MIN = (WALKING_SPEED_KMH * 1000) / 60;
const MAX_TRANSFER_WALK_METERS = 500;
const TRANSIT_TIMEOUT_MS = 10000;
const ODSAY_BASE_URL = "https://api.odsay.com/v1/api/searchPubTransPathT";

const routeCache = new Map();

const state = {
  map: null,
  places: null,
  marker: null,
  origin: { ...DEFAULT_ORIGIN },
  rectangles: [],
  kakaoKey: "",
  odsayKey: "",
  loading: false,
};

const elements = {
  kakaoKeyInput: document.getElementById("kakaoKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  odsayKeyInput: document.getElementById("odsayKeyInput"),
  saveOdsayBtn: document.getElementById("saveOdsayBtn"),
  keyword: document.getElementById("keyword"),
  searchBtn: document.getElementById("searchBtn"),
  radiusRange: document.getElementById("radiusRange"),
  maxRange: document.getElementById("maxRange"),
  radiusText: document.getElementById("radiusText"),
  maxText: document.getElementById("maxText"),
  departureMode: document.getElementById("departureMode"),
  customTimeBox: document.getElementById("customTimeBox"),
  dayType: document.getElementById("dayType"),
  timeInput: document.getElementById("timeInput"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  originLabel: document.getElementById("originLabel"),
  status: document.getElementById("status"),
  summary: document.getElementById("summary"),
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  bindUiEvents();
  syncLabels();
  loadStoredKeys();
}

function bindUiEvents() {
  elements.saveKeyBtn.addEventListener("click", async () => {
    const key = elements.kakaoKeyInput.value.trim();
    if (!key) {
      setStatus("카카오 JavaScript 키를 입력하세요.", true);
      return;
    }
    localStorage.setItem("KAKAO_JS_KEY", key);
    state.kakaoKey = key;
    await initializeMapIfNeeded();
  });

  elements.saveOdsayBtn.addEventListener("click", () => {
    const key = elements.odsayKeyInput.value.trim();
    localStorage.setItem("ODSAY_API_KEY", key);
    state.odsayKey = key;
    routeCache.clear();
    setStatus(key ? "ODsay 키를 저장했습니다." : "ODsay 키를 비웠습니다.");
  });

  elements.searchBtn.addEventListener("click", async () => {
    const keyword = elements.keyword.value.trim();
    if (!keyword) {
      return;
    }
    await searchOrigin(keyword);
  });

  elements.keyword.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      elements.searchBtn.click();
    }
  });

  elements.radiusRange.addEventListener("input", syncLabels);
  elements.maxRange.addEventListener("input", syncLabels);

  elements.departureMode.addEventListener("change", () => {
    const custom = elements.departureMode.value === "custom";
    elements.customTimeBox.classList.toggle("hidden", !custom);
  });

  elements.analyzeBtn.addEventListener("click", () => {
    runAnalysis();
  });
}

function loadStoredKeys() {
  state.kakaoKey = (localStorage.getItem("KAKAO_JS_KEY") || "").trim();
  state.odsayKey = (localStorage.getItem("ODSAY_API_KEY") || "").trim();
  elements.kakaoKeyInput.value = state.kakaoKey;
  elements.odsayKeyInput.value = state.odsayKey;

  if (!state.kakaoKey) {
    setStatus("카카오 키를 입력하고 저장하면 지도를 시작합니다.");
    return;
  }

  initializeMapIfNeeded();
}

async function initializeMapIfNeeded() {
  if (state.map) {
    setStatus("카카오 키가 저장되었습니다.");
    return;
  }

  try {
    setStatus("카카오 지도 SDK 로딩 중...");
    await loadKakaoSdk(state.kakaoKey);
    initializeMap();
    await searchOrigin(DEFAULT_ORIGIN.name, true);
    setStatus("지도 준비 완료. 히트맵 계산을 실행하세요.");
    await runAnalysis();
  } catch (error) {
    setStatus("카카오 키/도메인 설정을 확인하세요.", true);
  }
}

function loadKakaoSdk(appKey) {
  if (window.kakao && window.kakao.maps) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=${encodeURIComponent(appKey)}`;
    script.async = true;
    script.onload = () => {
      kakao.maps.load(resolve);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function initializeMap() {
  const container = document.getElementById("map");
  state.map = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(state.origin.lat, state.origin.lng),
    level: 6,
  });
  state.places = new kakao.maps.services.Places();
}

async function searchOrigin(keyword, silent = false) {
  if (!state.places) {
    setStatus("먼저 카카오 키를 저장하세요.", true);
    return;
  }

  if (!silent) {
    setStatus(`"${keyword}" 검색 중...`);
  }

  await new Promise((resolve) => {
    state.places.keywordSearch(keyword, (result, status) => {
      if (status !== kakao.maps.services.Status.OK || !result.length) {
        if (!silent) {
          setStatus("검색 결과가 없습니다.", true);
        }
        resolve();
        return;
      }

      const first = result[0];
      state.origin = {
        name: first.place_name || keyword,
        lat: Number(first.y),
        lng: Number(first.x),
      };
      updateOriginMarker();
      setStatus(`출발지를 "${state.origin.name}"로 설정했습니다.`);
      resolve();
    });
  });
}

function updateOriginMarker() {
  const position = new kakao.maps.LatLng(state.origin.lat, state.origin.lng);
  if (!state.marker) {
    state.marker = new kakao.maps.Marker({
      map: state.map,
      position,
    });
  } else {
    state.marker.setPosition(position);
  }

  elements.originLabel.textContent = `출발지: ${state.origin.name}`;
  state.map.setCenter(position);
}

async function runAnalysis() {
  if (!state.map || state.loading) {
    return;
  }

  state.loading = true;
  elements.analyzeBtn.disabled = true;
  setStatus("격자 계산 중...");

  try {
    const radiusMeters = clamp(Number(elements.radiusRange.value), MIN_RADIUS_METERS, MAX_RADIUS_METERS);
    const maxMinutes = clamp(Number(elements.maxRange.value), 20, 180);
    const departureMode = elements.departureMode.value === "custom" ? "custom" : "now";
    const dayType = normalizeDayType(elements.dayType.value);
    const time = normalizeTime(elements.timeInput.value || "08:30");
    const waitMultiplier = deriveWaitMultiplier(departureMode, dayType, time);

    const gridCells = generateGrid(state.origin, radiusMeters, GRID_SIZE_METERS);
    const sampledCells = pickSampleCells(gridCells, MAX_TRANSIT_SAMPLES);
    let transitSamples = [];

    if (state.odsayKey) {
      setStatus(`대중교통 샘플 계산 중... (${sampledCells.length}개)`);
      transitSamples = await runWithConcurrency(sampledCells, TRANSIT_CONCURRENCY, async (cell) => {
        const route = await fetchTransitRoute({
          origin: state.origin,
          destination: { lat: cell.lat, lng: cell.lng },
          dayType,
          time,
          apiKey: state.odsayKey,
        });

        if (!route.ok) {
          return { ...cell, transitMinutes: Number.POSITIVE_INFINITY };
        }

        return {
          ...cell,
          transitMinutes: route.baseMinutes + route.totalIntervalMinutes * 0.5 * waitMultiplier,
        };
      });
    }

    const validTransitSamples = transitSamples.filter((cell) => Number.isFinite(cell.transitMinutes));
    const computedCells = gridCells.map((cell) => {
      const walkDistanceMeters = Math.hypot(cell.eastMeters, cell.northMeters);
      const walkMinutes = (walkDistanceMeters * WALK_DETOUR_FACTOR) / WALKING_SPEED_M_PER_MIN;
      const transitMinutes = interpolateTransit(cell, validTransitSamples);
      const minutes = Math.min(walkMinutes, transitMinutes);
      return {
        ...cell,
        minutes,
        mode: minutes === walkMinutes ? "walk" : "transit",
      };
    });

    renderHeatmap(computedCells, maxMinutes);
    focusByRadius(radiusMeters);
    renderSummary({
      totalGrid: gridCells.length,
      sampled: sampledCells.length,
      validTransit: validTransitSamples.length,
      waitMultiplier,
      transitEnabled: Boolean(state.odsayKey),
    });

    if (state.odsayKey) {
      setStatus("히트맵 계산 완료.");
    } else {
      setStatus("ODsay 키가 없어 도보 기준으로 표시 중입니다.", true);
    }
  } catch (error) {
    setStatus(error.message || "히트맵 계산 실패", true);
  } finally {
    state.loading = false;
    elements.analyzeBtn.disabled = false;
  }
}

function renderHeatmap(cells, maxMinutes) {
  clearHeatmap();
  let visibleCount = 0;

  for (const cell of cells) {
    if (!Number.isFinite(cell.minutes) || cell.minutes > maxMinutes) {
      continue;
    }
    visibleCount += 1;
    const bounds = new kakao.maps.LatLngBounds(
      new kakao.maps.LatLng(cell.sw.lat, cell.sw.lng),
      new kakao.maps.LatLng(cell.ne.lat, cell.ne.lng)
    );
    const rectangle = new kakao.maps.Rectangle({
      bounds,
      strokeWeight: 0,
      strokeOpacity: 0,
      fillColor: colorByMinutes(cell.minutes, maxMinutes),
      fillOpacity: cell.mode === "walk" ? 0.26 : 0.58,
    });
    rectangle.setMap(state.map);
    state.rectangles.push(rectangle);
  }

  return visibleCount;
}

function renderSummary(meta) {
  elements.summary.innerHTML =
    `총 <strong>${Number(meta.totalGrid).toLocaleString()}</strong>칸 중 ` +
    `<strong>${Number(meta.sampled).toLocaleString()}</strong>칸 샘플링` +
    ` (유효 대중교통 <strong>${Number(meta.validTransit).toLocaleString()}</strong>칸)` +
    `<br>배차 반영: 이동시간 + 배차간격 x 0.5 x ${roundTo(meta.waitMultiplier, 2)}` +
    `${meta.transitEnabled ? "" : " / 도보 전용 모드"}`;
}

function clearHeatmap() {
  for (const rectangle of state.rectangles) {
    rectangle.setMap(null);
  }
  state.rectangles = [];
}

function focusByRadius(radiusMeters) {
  const latFactor = radiusMeters / 111320;
  const lngFactor = radiusMeters / (111320 * Math.cos((state.origin.lat * Math.PI) / 180));
  const bounds = new kakao.maps.LatLngBounds(
    new kakao.maps.LatLng(state.origin.lat - latFactor, state.origin.lng - lngFactor),
    new kakao.maps.LatLng(state.origin.lat + latFactor, state.origin.lng + lngFactor)
  );
  state.map.setBounds(bounds);
}

function generateGrid(origin, radiusMeters, stepMeters) {
  const halfCell = stepMeters / 2;
  const maxIndex = Math.floor(radiusMeters / stepMeters);
  const cells = [];

  for (let northIndex = -maxIndex; northIndex <= maxIndex; northIndex += 1) {
    for (let eastIndex = -maxIndex; eastIndex <= maxIndex; eastIndex += 1) {
      const northMeters = northIndex * stepMeters;
      const eastMeters = eastIndex * stepMeters;
      if (Math.hypot(northMeters, eastMeters) > radiusMeters) {
        continue;
      }

      const center = offsetLatLng(origin, eastMeters, northMeters);
      const sw = offsetLatLng(center, -halfCell, -halfCell);
      const ne = offsetLatLng(center, halfCell, halfCell);
      cells.push({
        eastIndex,
        northIndex,
        eastMeters,
        northMeters,
        lat: center.lat,
        lng: center.lng,
        sw,
        ne,
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
    (cell) => Math.abs(cell.eastIndex) % stride === 0 && Math.abs(cell.northIndex) % stride === 0
  );
  const center = cells.find((cell) => cell.eastIndex === 0 && cell.northIndex === 0);
  if (center && !sampled.some((cell) => cell.eastIndex === 0 && cell.northIndex === 0)) {
    sampled.push(center);
  }
  return sampled.slice(0, maxSamples);
}

async function fetchTransitRoute({ origin, destination, dayType, time, apiKey }) {
  const cacheKey = [
    roundTo(origin.lat, 5),
    roundTo(origin.lng, 5),
    roundTo(destination.lat, 5),
    roundTo(destination.lng, 5),
    dayType,
    time,
  ].join("|");

  const cached = routeCache.get(cacheKey);
  if (cached) {
    return cached;
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
    const json = await response.json();

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }
    if (json.error) {
      const code = Number(json.error.code);
      if (code === -98 || code === -99) {
        return { ok: false, reason: "no_path" };
      }
      return { ok: false, reason: json.error.msg || "odsay_error" };
    }

    const extracted = extractBestPath(json.result || {});
    routeCache.set(cacheKey, extracted);
    return extracted;
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
  if (Number.isFinite(searchType) && searchType !== 0) {
    return { ok: false, reason: "outside_city_network" };
  }

  const paths = Array.isArray(result.path) ? result.path : [];
  let best = null;

  for (const path of paths) {
    const pathType = toNumber(path.pathType);
    if (Number.isFinite(pathType) && ![1, 2, 3].includes(pathType)) {
      continue;
    }

    if (hasExcludedTransit(path.subPath)) {
      continue;
    }

    const totalWalk = toNumber(path.info?.totalWalk);
    if (Number.isFinite(totalWalk) && totalWalk > MAX_TRANSFER_WALK_METERS) {
      continue;
    }

    if (containsLongWalkSection(path.subPath)) {
      continue;
    }

    const baseMinutes = readBaseMinutes(path);
    if (!Number.isFinite(baseMinutes)) {
      continue;
    }

    const totalIntervalMinutes = readIntervalMinutes(path);
    const candidate = {
      ok: true,
      baseMinutes,
      totalIntervalMinutes: totalIntervalMinutes > 0 ? totalIntervalMinutes : 0,
    };

    const score = candidate.baseMinutes + candidate.totalIntervalMinutes * 0.5;
    const bestScore = best ? best.baseMinutes + best.totalIntervalMinutes * 0.5 : Number.POSITIVE_INFINITY;
    if (score < bestScore) {
      best = candidate;
    }
  }

  return best || { ok: false, reason: "no_valid_path" };
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
    if (Number.isFinite(distance) && distance > MAX_TRANSFER_WALK_METERS) {
      return true;
    }
  }
  return false;
}

function readBaseMinutes(path) {
  const infoMinutes = toNumber(path.info?.totalTime);
  if (Number.isFinite(infoMinutes)) {
    return infoMinutes;
  }
  const segments = Array.isArray(path.subPath) ? path.subPath : [];
  let total = 0;
  let found = false;
  for (const segment of segments) {
    const sectionTime = toNumber(segment.sectionTime);
    if (Number.isFinite(sectionTime)) {
      total += sectionTime;
      found = true;
    }
  }
  return found ? total : Number.NaN;
}

function readIntervalMinutes(path) {
  const infoInterval = toNumber(path.info?.totalIntervalTime);
  if (Number.isFinite(infoInterval) && infoInterval > 0) {
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
    if (!Number.isFinite(interval) || interval <= 0) {
      interval = readLaneInterval(segment.lane);
    }
    if (Number.isFinite(interval) && interval > 0) {
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
    if (Number.isFinite(interval) && interval > 0 && interval < best) {
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
  let weighted = 0;
  let totalWeight = 0;
  for (const item of top) {
    const weight = 1 / (item.distanceMeters * item.distanceMeters);
    weighted += item.transitMinutes * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return weighted / totalWeight;
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

function deriveWaitMultiplier(departureMode, dayType, time) {
  let baseDay = dayType;
  let baseTime = time;
  if (departureMode === "now") {
    const now = new Date();
    const day = now.getDay();
    baseDay = day === 0 ? "sunday" : day === 6 ? "saturday" : "weekday";
    baseTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
  const hour = Number(baseTime.split(":")[0]);
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

function colorByMinutes(minutes, maxMinutes) {
  const ratio = Math.max(0, Math.min(1, minutes / maxMinutes));
  const hue = 145 - ratio * 145;
  const saturation = 88;
  const lightness = 50 - ratio * 14;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function syncLabels() {
  elements.radiusText.textContent = elements.radiusRange.value;
  elements.maxText.textContent = elements.maxRange.value;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
