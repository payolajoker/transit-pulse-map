const DEFAULT_ORIGIN = {
  name: "판교역",
  lat: 37.3947384,
  lng: 127.1111955,
};

const state = {
  config: null,
  map: null,
  places: null,
  origin: { ...DEFAULT_ORIGIN },
  marker: null,
  rectangles: [],
  loading: false,
};

const elements = {
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

async function init() {
  bindUiEvents();
  syncLabels();
  setStatus("설정 정보를 확인 중입니다.");

  try {
    state.config = await fetchJson("/api/config");
  } catch (error) {
    setStatus("서버 설정을 불러오지 못했습니다.", true);
    return;
  }

  configureRanges();
  if (!state.config.kakaoJsKey) {
    setStatus("KAKAO_JS_KEY가 필요합니다. 키를 설정한 뒤 새로고침하세요.", true);
    return;
  }

  try {
    await loadKakaoSdk(state.config.kakaoJsKey);
  } catch (error) {
    setStatus("카카오 지도 SDK 로딩에 실패했습니다.", true);
    return;
  }

  initializeMap();
  await searchOrigin(DEFAULT_ORIGIN.name, true);
  await runAnalysis();
}

function bindUiEvents() {
  elements.searchBtn.addEventListener("click", () => {
    const keyword = elements.keyword.value.trim();
    if (!keyword) {
      return;
    }
    searchOrigin(keyword, false);
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

function configureRanges() {
  elements.radiusRange.min = String(state.config.minRadiusMeters || 300);
  elements.radiusRange.max = String(state.config.maxRadiusMeters || 1000);

  const clampedRadius = Math.max(
    Number(elements.radiusRange.min),
    Math.min(Number(elements.radiusRange.value), Number(elements.radiusRange.max))
  );
  elements.radiusRange.value = String(clampedRadius);
  syncLabels();
}

function syncLabels() {
  elements.radiusText.textContent = elements.radiusRange.value;
  elements.maxText.textContent = elements.maxRange.value;
}

function loadKakaoSdk(appKey) {
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
  const center = new kakao.maps.LatLng(state.origin.lat, state.origin.lng);
  state.map = new kakao.maps.Map(container, {
    center,
    level: 6,
  });
  state.places = new kakao.maps.services.Places();
}

async function searchOrigin(keyword, silent) {
  if (!state.places) {
    return;
  }

  if (!silent) {
    setStatus(`"${keyword}" 검색 중...`);
  }

  await new Promise((resolve) => {
    state.places.keywordSearch(keyword, (result, status) => {
      if (status !== kakao.maps.services.Status.OK || !result.length) {
        if (!silent) {
          setStatus("검색 결과가 없습니다. 다른 키워드를 입력하세요.", true);
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
      setStatus(`출발지를 "${state.origin.name}"(으)로 설정했습니다.`);
      resolve();
    });
  });
}

function updateOriginMarker() {
  if (!state.map) {
    return;
  }

  const latLng = new kakao.maps.LatLng(state.origin.lat, state.origin.lng);
  if (!state.marker) {
    state.marker = new kakao.maps.Marker({
      position: latLng,
      map: state.map,
    });
  } else {
    state.marker.setPosition(latLng);
  }

  elements.originLabel.textContent = `출발지: ${state.origin.name}`;
  state.map.setCenter(latLng);
}

async function runAnalysis() {
  if (state.loading || !state.map) {
    return;
  }

  const payload = {
    origin: {
      lat: state.origin.lat,
      lng: state.origin.lng,
    },
    radiusMeters: Number(elements.radiusRange.value),
    maxMinutes: Number(elements.maxRange.value),
    departureMode: elements.departureMode.value,
    dayType: elements.dayType.value,
    time: elements.timeInput.value,
  };

  state.loading = true;
  elements.analyzeBtn.disabled = true;
  setStatus("격자를 계산하고 있습니다. 잠시만 기다려주세요.");

  try {
    const response = await fetchJson("/api/isochrone", payload);
    renderHeatmap(response.cells, payload.maxMinutes);
    focusByRadius(payload.radiusMeters);
    renderSummary(response);

    if (response.settings.transitEnabled) {
      setStatus("히트맵 계산이 완료되었습니다.");
    } else {
      setStatus("ODSAY 키가 없어 도보 기준 히트맵만 표시 중입니다.", true);
    }
  } catch (error) {
    setStatus(error.message || "히트맵 계산에 실패했습니다.", true);
  } finally {
    state.loading = false;
    elements.analyzeBtn.disabled = false;
  }
}

function renderHeatmap(cells, maxMinutes) {
  clearHeatmap();

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
      fillOpacity: cell.mode === "walk" ? 0.25 : 0.58,
    });
    rectangle.setMap(state.map);
    state.rectangles.push(rectangle);
  }
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

function renderSummary(response) {
  const stats = response.stats;
  const settings = response.settings;
  const notes = stats.notes && stats.notes.length ? ` / ${stats.notes.join(" ")}` : "";

  elements.summary.innerHTML =
    `<strong>${Number(stats.totalGridCells).toLocaleString()}</strong>칸 중 ` +
    `<strong>${Number(stats.sampledTransitCells).toLocaleString()}</strong>칸을 대중교통 API로 샘플링` +
    ` (유효 샘플 ${Number(stats.validTransitSamples).toLocaleString()}칸)` +
    `<br>배차 대기 반영: 이동시간 + 배차간격 x 0.5 x ${settings.waitMultiplier}${notes}`;
}

function colorByMinutes(minutes, maxMinutes) {
  const ratio = Math.max(0, Math.min(1, minutes / maxMinutes));
  const hue = 145 - ratio * 145;
  const saturation = 88;
  const lightness = 50 - ratio * 14;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

async function fetchJson(url, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || "요청 실패");
  }
  return json;
}
