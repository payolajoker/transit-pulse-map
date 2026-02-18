# Transit Pulse Map

출발지를 기준으로, 주변 지역을 `300m x 300m` 격자 히트맵으로 표시하는 웹앱입니다.

- 대중교통 시간 규칙: `순수 이동시간 + (배차간격 x 0.5)`
- 도보 포함
- 도보 제한(대중교통 경로 내 총 도보): `500m`
- KTX/시외/항공 제외, 버스/도시철도(데이터에 GTX 포함 시 반영)

## 1) 실행

```bash
npm install
cp .env.example .env
npm start
```

브라우저에서 `http://localhost:3000` 접속.

## 2) 키 설정

`.env` 파일에 아래를 넣으세요.

```env
KAKAO_JS_KEY=여기에_카카오_JavaScript_키
ODSAY_API_KEY=여기에_ODsay_API_키
```

- `KAKAO_JS_KEY`가 없으면 지도를 띄울 수 없습니다.
- `ODSAY_API_KEY`가 없으면 앱은 **도보 기준 히트맵만** 표시합니다.

## 3) 계산 부하 제어 방식

- 최종 표시는 항상 300m 격자
- 대중교통 API는 샘플 격자만 조회(기본 최대 90개) 후 보간
- 반경 기본값/최대값을 제한(기본 800m, 최대 1000m)해서 한 화면 격자 수를 제어

관련 환경변수:

- `MAX_TRANSIT_SAMPLES` (기본 90)
- `MAX_RADIUS_METERS` (기본 1000)
- `TRANSIT_CONCURRENCY` (기본 5)

## 4) 기준 시간

UI에서 `현재 시각` 또는 `요일/시간 직접 설정` 가능.

- 대중교통 기본 경로는 ODsay 도시내 경로를 사용
- 요일/시간 설정은 배차 대기 가중치에 반영

## 5) API 정책 참고

- ODsay 정책/가이드: <https://lab.odsay.com/doc/totalPolicy>
- ODsay API 레퍼런스: <https://lab.odsay.com/guide/releaseReference>
- 카카오 쿼터/요금: <https://developers.kakao.com/docs/latest/ko/getting-started/quota>
- 카카오맵 공통 가이드: <https://developers.kakao.com/docs/latest/ko/kakaomap/common>
