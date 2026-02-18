const DEFAULT_DESTINATION = {
  name: "판교역",
  lat: 37.3947384,
  lng: 127.1111955,
};

const DEFAULT_START_CENTER = {
  name: "삼동역",
  lat: 37.4086109,
  lng: 127.2036487,
};

const DEFAULT_KAKAO_JS_KEY = "c2db0ea3cf94c9b50e56b5883f54537a";
const DEFAULT_ODSAY_API_KEY = "l2WkmLEOPXsRboziAntgKg";

const GRID_SIZE_METERS = 500;
const MIN_RADIUS_METERS = 20000;
const MAX_RADIUS_METERS = 20000;
const MAX_TRANSIT_SAMPLES = 30;
const TRANSIT_CONCURRENCY = 4;
const MAX_TRANSFER_WALK_METERS = 500;
const WALKING_SPEED_KMH = 4.5;
const WALK_DETOUR_FACTOR = 1.22;
const WALKING_SPEED_M_PER_MIN = (WALKING_SPEED_KMH * 1000) / 60;
const TRANSIT_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_SIZE = 6000;
const CACHE_TIME_BUCKET_MIN = 30;
const ODSAY_BASE_URL = "https://api.odsay.com/v1/api/searchPubTransPathT";

const routeCache = new Map();

const state = {
  map: null,
  places: null,
  destination: { ...DEFAULT_DESTINATION },
  startCenter: { ...DEFAULT_START_CENTER },
  destinationMarker: null,
  startMarker: null,
  rectangles: [],
  clickMode: "destination",
  loading: false,
  kakaoKey: "",
  odsayKey: "",
  latest: null,
};

const elements = {
  kakaoKeyInput: document.getElementById("kakaoKeyInput"),
  saveKakaoBtn: document.getElementById("saveKakaoBtn"),
  odsayKeyInput: document.getElementById("odsayKeyInput"),
  saveOdsayBtn: document.getElementById("saveOdsayBtn"),
  destinationKeyword: document.getElementById("destinationKeyword"),
  searchDestinationBtn: document.getElementById("searchDestinationBtn"),
  startKeyword: document.getElementById("startKeyword"),
  searchStartBtn: document.getElementById("searchStartBtn"),
  destinationLabel: document.getElementById("destinationLabel"),
  startLabel: document.getElementById("startLabel"),
  modeDestinationBtn: document.getElementById("modeDestinationBtn"),
  modeStartBtn: document.getElementById("modeStartBtn"),
  radiusRange: document.getElementById("radiusRange"),
  maxRange: document.getElementById("maxRange"),
  radiusText: document.getElementById("radiusText"),
  maxText: document.getElementById("maxText"),
  departureMode: document.getElementById("departureMode"),
  customTimeBox: document.getElementById("customTimeBox"),
  dayType: document.getElementById("dayType"),
  timeInput: document.getElementById("timeInput"),
  analyzeBtn: document.getElementById("analyzeBtn"),
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
  elements.saveKakaoBtn.addEventListener("click", async () => {
    const key = elements.kakaoKeyInput.value.trim();
    if (!key) {
      setStatus("카카오 JavaScript 키를 입력하세요.", true);
      return;
    }
    state.kakaoKey = key;
    localStorage.setItem("KAKAO_JS_KEY", key);
    await initializeMapIfNeeded();
  });

  elements.saveOdsayBtn.addEventListener("click", () => {
    const key = elements.odsayKeyInput.value.trim();
    state.odsayKey = key;
    localStorage.setItem("ODSAY_API_KEY", key);
    routeCache.clear();
    setStatus(key ? "ODsay 키를 저장했습니다." : "ODsay 키를 비웠습니다.");
  });

  elements.searchDestinationBtn.addEventListener("click", () => {
    searchPointByKeyword("destination", elements.destinationKeyword.value.trim());
  });

  elements.searchStartBtn.addEventListener("click", () => {
    searchPointByKeyword("startCenter", elements.startKeyword.value.trim());
  });

  elements.destinationKeyword.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      elements.searchDestinationBtn.click();
    }
  });

  elements.startKeyword.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      elements.searchStartBtn.click();
    }
  });

  elements.modeDestinationBtn.addEventListener("click", () => {
    setClickMode("destination");
  });

  elements.modeStartBtn.addEventListener("click", () => {
    setClickMode("startCenter");
  });

  elements.radiusRange.addEventListener("input", () => {
    syncLabels();
  });

  elements.maxRange.addEventListener("input", () => {
    syncLabels();
    if (!state.loading && state.latest) {
      renderFromLatest(true);
      setStatus("색상 범위만 다시 렌더링했습니다. ODsay 재호출은 없습니다.");
    }
  });

  elements.departureMode.addEventListener("change", () => {
    const custom = elements.departureMode.value === "custom";
    elements.customTimeBox.classList.toggle("hidden", !custom);
  });

  elements.analyzeBtn.addEventListener("click", () => {
    runAnalysis();
  });
}

function loadStoredKeys() {
  state.kakaoKey = (localStorage.getItem("KAKAO_JS_KEY") || DEFAULT_KAKAO_JS_KEY).trim();
  state.odsayKey = (localStorage.getItem("ODSAY_API_KEY") || DEFAULT_ODSAY_API_KEY).trim();
  localStorage.setItem("KAKAO_JS_KEY", state.kakaoKey);
  localStorage.setItem("ODSAY_API_KEY", state.odsayKey);
  elements.kakaoKeyInput.value = state.kakaoKey;
  elements.odsayKeyInput.value = state.odsayKey;

  if (!state.kakaoKey) {
    setStatus("카카오 키를 입력하고 저장하세요.", true);
    return;
  }
  initializeMapIfNeeded();
}

async function initializeMapIfNeeded() {
  if (state.map) {
    setStatus("지도가 이미 준비되어 있습니다.");
    return;
  }

  try {
    setStatus("카카오 지도 SDK 로딩 중...");
    await loadKakaoSdk(state.kakaoKey);
    initializeMap();
    updateMarkersAndLabels();
    bindMapClick();
    setClickMode("destination");
    setStatus("지도 준비 완료. 클릭 모드로 목적지/출발지 중심을 지정할 수 있습니다.");
    await runAnalysis();
  } catch (error) {
    setStatus("카카오 키 또는 도메인 설정을 확인하세요.", true);
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
  state.map = new kakao.maps.Map(document.getElementById("map"), {
    center: new kakao.maps.LatLng(state.destination.lat, state.destination.lng),
    level: 7,
  });
  state.places = new kakao.maps.services.Places();
}

function bindMapClick() {
  kakao.maps.event.addListener(state.map, "click", (mouseEvent) => {
    const lat = mouseEvent.latLng.getLat();
    const lng = mouseEvent.latLng.getLng();
    if (state.clickMode === "destination") {
      setPoint("destination", {
        name: "지도 지정 목적지",
        lat,
        lng,
      });
      setStatus("목적지를 지도 클릭으로 설정했습니다.");
    } else {
      setPoint("startCenter", {
        name: "지도 지정 출발지 중심",
        lat,
        lng,
      });
      setStatus("출발지 중심을 지도 클릭으로 설정했습니다.");
    }
    runAnalysis();
  });
}

function setClickMode(mode) {
  state.clickMode = mode;
  elements.modeDestinationBtn.classList.toggle("active", mode === "destination");
  elements.modeStartBtn.classList.toggle("active", mode === "startCenter");
}

async function searchPointByKeyword(kind, keyword) {
  if (!keyword) {
    return;
  }
  if (!state.places) {
    setStatus("지도를 먼저 초기화하세요.", true);
    return;
  }

  setStatus(`"${keyword}" 검색 중...`);
  await new Promise((resolve) => {
    state.places.keywordSearch(keyword, (result, status) => {
      if (status !== kakao.maps.services.Status.OK || !result.length) {
        setStatus("검색 결과가 없습니다.", true);
        resolve();
        return;
      }
      const first = result[0];
      setPoint(kind, {
        name: first.place_name || keyword,
        lat: Number(first.y),
        lng: Number(first.x),
      });
      setStatus(
        kind === "destination"
          ? `목적지를 "${first.place_name}"로 설정했습니다.`
          : `출발지 중심을 "${first.place_name}"로 설정했습니다.`
      );
      runAnalysis();
      resolve();
    });
  });
}

function setPoint(kind, point) {
  if (kind === "destination") {
    state.destination = point;
  } else {
    state.startCenter = point;
  }
  updateMarkersAndLabels();
}

function updateMarkersAndLabels() {
  if (!state.map || !window.kakao) {
    return;
  }

  const destinationPos = new kakao.maps.LatLng(state.destination.lat, state.destination.lng);
  const startPos = new kakao.maps.LatLng(state.startCenter.lat, state.startCenter.lng);

  if (!state.destinationMarker) {
    state.destinationMarker = new kakao.maps.Marker({
      map: state.map,
      position: destinationPos,
      title: "목적지",
      zIndex: 3,
    });
  } else {
    state.destinationMarker.setPosition(destinationPos);
  }

  if (!state.startMarker) {
    state.startMarker = new kakao.maps.Marker({
      map: state.map,
      position: startPos,
      title: "출발지 중심",
      zIndex: 2,
    });
  } else {
    state.startMarker.setPosition(startPos);
  }

  elements.destinationLabel.textContent = `목적지: ${state.destination.name}`;
  elements.startLabel.textContent = `출발지 중심: ${state.startCenter.name}`;
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
    const schedule = resolveSchedule(
      elements.departureMode.value,
      normalizeDayType(elements.dayType.value),
      normalizeTime(elements.timeInput.value || "08:30")
    );
    const waitMultiplier = deriveWaitMultiplier(schedule.dayType, schedule.time);
    const scheduleKey = `${schedule.dayType}-${toTimeBucket(schedule.time, CACHE_TIME_BUCKET_MIN)}`;

    const gridCells = generateGrid(state.startCenter, radiusMeters, GRID_SIZE_METERS);
    const sampledCells = pickSampleCells(gridCells, MAX_TRANSIT_SAMPLES);

    const stats = {
      totalGrid: gridCells.length,
      sampled: sampledCells.length,
      validTransit: 0,
      apiCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      transitEnabled: Boolean(state.odsayKey),
      waitMultiplier,
      radiusMeters,
    };

    let transitSamples = [];
    if (state.odsayKey) {
      setStatus(`대중교통 샘플 계산 중... (${sampledCells.length}개)`);
      transitSamples = await runWithConcurrency(sampledCells, TRANSIT_CONCURRENCY, async (cell) => {
        const route = await fetchTransitRoute({
          from: { lat: cell.lat, lng: cell.lng },
          to: state.destination,
          scheduleKey,
          apiKey: state.odsayKey,
          stats,
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
    stats.validTransit = validTransitSamples.length;

    const computedCells = gridCells.map((cell) => {
      const walkDistanceMeters = distanceMeters(
        { lat: cell.lat, lng: cell.lng },
        { lat: state.destination.lat, lng: state.destination.lng }
      );
      const walkMinutes = (walkDistanceMeters * WALK_DETOUR_FACTOR) / WALKING_SPEED_M_PER_MIN;
      const transitMinutes = interpolateTransit(cell, validTransitSamples);
      const minutes = Math.min(walkMinutes, transitMinutes);
      return {
        ...cell,
        minutes,
        mode: minutes === walkMinutes ? "walk" : "transit",
      };
    });

    state.latest = {
      cells: computedCells,
      stats,
      radiusMeters,
    };

    renderFromLatest(false);
    if (stats.transitEnabled) {
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

function renderFromLatest(isRerenderOnly) {
  if (!state.latest) {
    return;
  }
  const maxMinutes = clamp(Number(elements.maxRange.value), 20, 180);
  const visibleCount = renderHeatmap(state.latest.cells, maxMinutes);
  if (!isRerenderOnly) {
    focusByRadius(state.startCenter, state.latest.radiusMeters);
  }
  renderSummary(state.latest.stats, visibleCount, maxMinutes);
}

function renderHeatmap(cells, maxMinutes) {
  clearHeatmap();
  let visibleCount = 0;

  for (const cell of cells) {
    if (!Number.isFinite(cell.minutes) || cell.minutes > maxMinutes) {
      continue;
    }

    const bounds = new kakao.maps.LatLngBounds(
      new kakao.maps.LatLng(cell.sw.lat, cell.sw.lng),
      new kakao.maps.LatLng(cell.ne.lat, cell.ne.lng)
    );
    const rectangle = new kakao.maps.Rectangle({
      bounds,
      strokeWeight: 0,
      strokeOpacity: 0,
      fillColor: colorByMinutes(cell.minutes, maxMinutes),
      fillOpacity: cell.mode === "walk" ? 0.24 : 0.58,
    });
    rectangle.setMap(state.map);
    state.rectangles.push(rectangle);
    visibleCount += 1;
  }

  return visibleCount;
}

function clearHeatmap() {
  for (const rectangle of state.rectangles) {
    rectangle.setMap(null);
  }
  state.rectangles = [];
}

function renderSummary(stats, visibleCount, maxMinutes) {
  const line1 =
    `목적지 <strong>${escapeHtml(state.destination.name)}</strong> / ` +
    `출발지 중심 <strong>${escapeHtml(state.startCenter.name)}</strong>`;
  const line2 =
    `표시 <strong>${Number(visibleCount).toLocaleString()}</strong>칸 / 전체 <strong>${Number(stats.totalGrid).toLocaleString()}</strong>칸, ` +
    `샘플 <strong>${Number(stats.sampled).toLocaleString()}</strong>칸, ` +
    `유효 대중교통 <strong>${Number(stats.validTransit).toLocaleString()}</strong>칸`;
  const line3 =
    `이번 ODsay 호출 <strong>${Number(stats.apiCalls).toLocaleString()}</strong>회 ` +
    `(cache hit ${Number(stats.cacheHits).toLocaleString()} / miss ${Number(stats.cacheMisses).toLocaleString()})`;
  const line4 =
    `배차 반영: 이동시간 + 배차간격 x 0.5 x ${roundTo(stats.waitMultiplier, 2)} ` +
    `/ 색상 상한 ${maxMinutes}분`;

  elements.summary.innerHTML = [line1, line2, line3, line4].join("<br>");
}

function focusByRadius(center, radiusMeters) {
  const latFactor = radiusMeters / 111320;
  const lngFactor = radiusMeters / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const bounds = new kakao.maps.LatLngBounds(
    new kakao.maps.LatLng(center.lat - latFactor, center.lng - lngFactor),
    new kakao.maps.LatLng(center.lat + latFactor, center.lng + lngFactor)
  );
  state.map.setBounds(bounds);
}

function generateGrid(center, radiusMeters, stepMeters) {
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

      const cellCenter = offsetLatLng(center, eastMeters, northMeters);
      const sw = offsetLatLng(cellCenter, -halfCell, -halfCell);
      const ne = offsetLatLng(cellCenter, halfCell, halfCell);

      cells.push({
        eastIndex,
        northIndex,
        eastMeters,
        northMeters,
        lat: cellCenter.lat,
        lng: cellCenter.lng,
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

async function fetchTransitRoute({ from, to, scheduleKey, apiKey, stats }) {
  const cacheKey = buildCacheKey(from, to, scheduleKey);
  const cached = getCachedRoute(cacheKey);
  if (cached) {
    stats.cacheHits += 1;
    return cached;
  }

  stats.cacheMisses += 1;
  stats.apiCalls += 1;
  const result = await queryOdsay(from, to, apiKey);
  setCachedRoute(cacheKey, result);
  return result;
}

async function queryOdsay(from, to, apiKey) {
  const params = new URLSearchParams({
    SX: String(from.lng),
    SY: String(from.lat),
    EX: String(to.lng),
    EY: String(to.lat),
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

    const errorObj = normalizeApiError(json.error);
    if (errorObj) {
      const code = Number(errorObj.code);
      if (code === -98 || code === -99) {
        return { ok: false, reason: "no_path" };
      }
      return { ok: false, reason: errorObj.message || errorObj.msg || "odsay_error" };
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

function normalizeApiError(errorValue) {
  if (!errorValue) {
    return null;
  }
  if (Array.isArray(errorValue)) {
    return errorValue[0] || null;
  }
  if (typeof errorValue === "object") {
    return errorValue;
  }
  return null;
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
    if (containsLongWalkSection(path.subPath)) {
      continue;
    }

    const baseMinutes = readBaseMinutes(path);
    if (!Number.isFinite(baseMinutes)) {
      continue;
    }
    const totalIntervalMinutes = readIntervalMinutes(path);
    const score = baseMinutes + totalIntervalMinutes * 0.5;
    if (!best || score < best.score) {
      best = {
        ok: true,
        baseMinutes,
        totalIntervalMinutes: totalIntervalMinutes > 0 ? totalIntervalMinutes : 0,
        score,
      };
    }
  }

  if (!best) {
    return { ok: false, reason: "no_valid_path" };
  }
  return {
    ok: true,
    baseMinutes: best.baseMinutes,
    totalIntervalMinutes: best.totalIntervalMinutes,
  };
}

function hasExcludedTransit(subPath) {
  const segments = Array.isArray(subPath) ? subPath : [];
  return segments.some((segment) => [4, 5, 6, 7].includes(Number(segment.trafficType)));
}

function containsLongWalkSection(subPath) {
  const segments = Array.isArray(subPath) ? subPath : [];
  return segments.some((segment) => {
    if (Number(segment.trafficType) !== 3) {
      return false;
    }
    const distance = toNumber(segment.distance);
    return Number.isFinite(distance) && distance > MAX_TRANSFER_WALK_METERS;
  });
}

function readBaseMinutes(path) {
  const totalTime = toNumber(path.info?.totalTime);
  if (Number.isFinite(totalTime)) {
    return totalTime;
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

  const candidates = [];
  for (const sample of sampleCells) {
    const distanceFromSample = Math.hypot(
      sample.eastMeters - cell.eastMeters,
      sample.northMeters - cell.northMeters
    );
    if (distanceFromSample < 1) {
      return sample.transitMinutes;
    }
    const startOffsetWalk = (distanceFromSample * WALK_DETOUR_FACTOR) / WALKING_SPEED_M_PER_MIN;
    candidates.push({
      distanceFromSample,
      value: sample.transitMinutes + startOffsetWalk,
    });
  }

  candidates.sort((a, b) => a.distanceFromSample - b.distanceFromSample);
  const top = candidates.slice(0, 4);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of top) {
    const weight = 1 / (item.distanceFromSample * item.distanceFromSample);
    weightedSum += item.value * weight;
    weightTotal += weight;
  }

  if (weightTotal <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return weightedSum / weightTotal;
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

function buildCacheKey(from, to, scheduleKey) {
  return [
    roundTo(from.lat, 5),
    roundTo(from.lng, 5),
    roundTo(to.lat, 5),
    roundTo(to.lng, 5),
    scheduleKey,
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

function resolveSchedule(departureMode, dayType, time) {
  if (departureMode !== "custom") {
    const now = new Date();
    const nowDay = now.getDay();
    return {
      dayType: nowDay === 0 ? "sunday" : nowDay === 6 ? "saturday" : "weekday",
      time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    };
  }
  return { dayType, time };
}

function deriveWaitMultiplier(dayType, time) {
  const hour = Number(time.split(":")[0]);
  let multiplier = 1;
  if (dayType === "saturday") {
    multiplier *= 1.08;
  }
  if (dayType === "sunday") {
    multiplier *= 1.12;
  }
  if (dayType === "weekday" && ((hour >= 7 && hour < 9) || (hour >= 17 && hour < 20))) {
    multiplier *= 0.9;
  }
  if (hour >= 23 || hour < 5) {
    multiplier *= 1.25;
  }
  return multiplier;
}

function toTimeBucket(time, intervalMinutes) {
  const [h, m] = time.split(":").map((part) => Number(part));
  const totalMinutes = h * 60 + m;
  const bucket = Math.floor(totalMinutes / intervalMinutes) * intervalMinutes;
  const hour = Math.floor(bucket / 60) % 24;
  const minute = bucket % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function distanceMeters(a, b) {
  const r = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function offsetLatLng(origin, eastMeters, northMeters) {
  const latDelta = northMeters / 111320;
  const lngDelta = eastMeters / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return {
    lat: origin.lat + latDelta,
    lng: origin.lng + lngDelta,
  };
}

function colorByMinutes(minutes, maxMinutes) {
  const ratio = Math.max(0, Math.min(1, minutes / maxMinutes));
  const hue = 145 - ratio * 145;
  const saturation = 88;
  const lightness = 50 - ratio * 14;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
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

function syncLabels() {
  elements.radiusText.textContent = elements.radiusRange.value;
  elements.maxText.textContent = elements.maxRange.value;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
