const DEFAULT_ORIGIN = {
  name: "판교역",
  lat: 37.3947384,
  lng: 127.1111955,
};

const GRID_SIZE_METERS = 50;
const WALKING_SPEED_KMH = 4.5;
const WALK_DETOUR_FACTOR = 1.22;
const WALKING_SPEED_M_PER_MIN = (WALKING_SPEED_KMH * 1000) / 60;

const state = {
  map: null,
  places: null,
  marker: null,
  origin: { ...DEFAULT_ORIGIN },
  rectangles: [],
  keyLoaded: false,
};

const elements = {
  kakaoKeyInput: document.getElementById("kakaoKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  keyword: document.getElementById("keyword"),
  searchBtn: document.getElementById("searchBtn"),
  radiusRange: document.getElementById("radiusRange"),
  maxRange: document.getElementById("maxRange"),
  radiusText: document.getElementById("radiusText"),
  maxText: document.getElementById("maxText"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  originLabel: document.getElementById("originLabel"),
  status: document.getElementById("status"),
  summary: document.getElementById("summary"),
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  bindUiEvents();
  syncLabels();
  loadKeyFromStorage();
}

function bindUiEvents() {
  elements.saveKeyBtn.addEventListener("click", async () => {
    const key = elements.kakaoKeyInput.value.trim();
    if (!key) {
      setStatus("카카오 JavaScript 키를 입력하세요.", true);
      return;
    }
    localStorage.setItem("KAKAO_JS_KEY", key);
    await initializeWithKey(key);
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

  elements.analyzeBtn.addEventListener("click", () => {
    if (!state.keyLoaded) {
      setStatus("먼저 카카오 키를 저장하세요.", true);
      return;
    }
    runWalkAnalysis();
  });
}

function loadKeyFromStorage() {
  const key = localStorage.getItem("KAKAO_JS_KEY") || "";
  elements.kakaoKeyInput.value = key;
  if (!key) {
    setStatus("카카오 키를 입력하고 저장하면 지도를 시작합니다.");
    return;
  }
  initializeWithKey(key);
}

async function initializeWithKey(key) {
  try {
    setStatus("카카오 지도 SDK 로딩 중...");
    await loadKakaoSdk(key);
    initializeMap();
    state.keyLoaded = true;
    setStatus("지도 준비 완료. 히트맵 계산 버튼을 눌러주세요.");
    await searchOrigin(DEFAULT_ORIGIN.name, true);
    runWalkAnalysis();
  } catch (error) {
    state.keyLoaded = false;
    setStatus("카카오 키가 올바른지 확인하세요. 도메인 등록도 필요합니다.", true);
  }
}

function loadKakaoSdk(appKey) {
  if (window.kakao && window.kakao.maps) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      `https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=${encodeURIComponent(appKey)}`;
    script.async = true;
    script.onload = () => {
      kakao.maps.load(resolve);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function initializeMap() {
  if (state.map) {
    return;
  }
  const container = document.getElementById("map");
  state.map = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(state.origin.lat, state.origin.lng),
    level: 6,
  });
  state.places = new kakao.maps.services.Places();
}

async function searchOrigin(keyword, silent = false) {
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

function runWalkAnalysis() {
  const radiusMeters = Number(elements.radiusRange.value);
  const maxMinutes = Number(elements.maxRange.value);
  const cells = generateWalkGrid(state.origin, radiusMeters);

  clearHeatmap();

  let visibleCount = 0;
  for (const cell of cells) {
    if (cell.minutes > maxMinutes) {
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
      fillColor: colorByMinutes(cell.minutes, maxMinutes),
      fillOpacity: 0.33,
    });
    rectangle.setMap(state.map);
    state.rectangles.push(rectangle);
  }

  focusByRadius(radiusMeters);
  elements.summary.innerHTML =
    `표시 격자 <strong>${Number(visibleCount).toLocaleString()}</strong>칸` +
    ` / 전체 <strong>${Number(cells.length).toLocaleString()}</strong>칸` +
    `<br>현재 GitHub Pages 미리보기는 도보 기준입니다.`;
}

function generateWalkGrid(origin, radiusMeters) {
  const cells = [];
  const maxIndex = Math.floor(radiusMeters / GRID_SIZE_METERS);
  const halfCell = GRID_SIZE_METERS / 2;

  for (let northIndex = -maxIndex; northIndex <= maxIndex; northIndex += 1) {
    for (let eastIndex = -maxIndex; eastIndex <= maxIndex; eastIndex += 1) {
      const northMeters = northIndex * GRID_SIZE_METERS;
      const eastMeters = eastIndex * GRID_SIZE_METERS;
      if (Math.hypot(northMeters, eastMeters) > radiusMeters) {
        continue;
      }

      const center = offsetLatLng(origin, eastMeters, northMeters);
      const sw = offsetLatLng(center, -halfCell, -halfCell);
      const ne = offsetLatLng(center, halfCell, halfCell);
      const distance = Math.hypot(northMeters, eastMeters) * WALK_DETOUR_FACTOR;
      const minutes = distance / WALKING_SPEED_M_PER_MIN;

      cells.push({
        sw,
        ne,
        minutes,
      });
    }
  }

  return cells;
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

function colorByMinutes(minutes, maxMinutes) {
  const ratio = Math.max(0, Math.min(1, minutes / maxMinutes));
  const hue = 145 - ratio * 145;
  const saturation = 88;
  const lightness = 50 - ratio * 14;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function offsetLatLng(origin, eastMeters, northMeters) {
  const latDelta = northMeters / 111320;
  const lngDelta = eastMeters / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return {
    lat: origin.lat + latDelta,
    lng: origin.lng + lngDelta,
  };
}

function syncLabels() {
  elements.radiusText.textContent = elements.radiusRange.value;
  elements.maxText.textContent = elements.maxRange.value;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}
