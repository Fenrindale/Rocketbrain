# 기능별 현재 상태

2026-11-26 기준 Rocketbrain 0.122.0. IntelliJ IDEA 120개와 DataGrip 96개, 총216개 항목을 유지한다.

각 판정은 기재한 지원 범위의 판정이다. 전체 원본 제품과의 동등성을 검증했다는 뜻은 아니다. 지원 범위·남은 범위·검증 범위와 공개 소스 경로는 [전체 판정 데이터](feature-status.json)에 있다.

미변경 행의 검증 수치와 인용된 최종 VSIX 표현은 보존한 이전 검증 이력이다. 현재 릴리스의 실제 집계와 실행 소스 귀속은 [검증 요약](verification.json)에 별도로 기록한다.

| 판정 | 항목 수 |
| --- | ---: |
| 구현 | 173 |
| 부분 구현 | 29 |
| 미구현 | 0 |
| VS Code 재사용 | 12 |
| 지원 미확인 | 0 |
| 호스트 구조 제약 | 2 |

기능표 가중 점수는 **92.4%**다. (구현 + VS Code 재사용 + 부분 구현의 절반) ÷ 216으로 계산한다. 부분 구현 안에서 지원 범위가 늘면 각 행의 검증 기록에 반영한다.

v0.122에서는 동적 Spring 주입·인증 결정, 가변 인자를 사용하는 Java Change Signature, Maven·Gradle 소스 모듈 분석, macOS Java 프로세스 디버깅과 Docker 빌드·푸시를 추가했다. 상태가 바뀐 항목은 1개이고 가중 점수는 199점에서 199.5점으로 바뀌었다.

| ID | 제품 | 기능 | 현재 판정 |
| --- | --- | --- | --- |
| IDEA-001 | IntelliJ IDEA | IDE 전체 배치·도킹·네이티브 화면 | 호스트 구조 제약 |
| IDEA-002 | IntelliJ IDEA | 프로젝트·패키지·모듈 탐색 | 구현 |
| IDEA-003 | IntelliJ IDEA | Search Everywhere 통합 검색 | 구현 |
| IDEA-004 | IntelliJ IDEA | 최근 파일·편집 위치·뒤로/앞으로 | VS Code 재사용 |
| IDEA-005 | IntelliJ IDEA | 다중 커서·열 선택·일괄 편집 | VS Code 재사용 |
| IDEA-006 | IntelliJ IDEA | 의미 기반 선택 확장·축소 | 구현 |
| IDEA-007 | IntelliJ IDEA | 문맥·타입 기반 코드 완성 | 구현 |
| IDEA-008 | IntelliJ IDEA | 파라미터 정보·빠른 문서 | 구현 |
| IDEA-009 | IntelliJ IDEA | Live Templates·Postfix 완성 | 구현 |
| IDEA-010 | IntelliJ IDEA | 코드 포맷·EditorConfig | 구현 |
| IDEA-011 | IntelliJ IDEA | 자동 import·사용하지 않는 import 정리 | 구현 |
| IDEA-012 | IntelliJ IDEA | 인레이 힌트·의미 강조 | 구현 |
| IDEA-013 | IntelliJ IDEA | 로컬 변경 이력·삭제 복구 | VS Code 재사용 |
| IDEA-014 | IntelliJ IDEA | 새 파일 템플릿 | 구현 |
| IDEA-015 | IntelliJ IDEA | 선언·타입·구현·상위 메서드 이동 | 구현 |
| IDEA-016 | IntelliJ IDEA | Find Usages·참조 탐색 | 구현 |
| IDEA-017 | IntelliJ IDEA | 호출 계층 | 구현 |
| IDEA-018 | IntelliJ IDEA | 타입·상속 계층 | 구현 |
| IDEA-019 | IntelliJ IDEA | Structure·현재 파일 기호 | 구현 |
| IDEA-020 | IntelliJ IDEA | 정적 Data Flow to/from Here | 구현 |
| IDEA-021 | IntelliJ IDEA | 구조 검색·치환 | 구현 |
| IDEA-022 | IntelliJ IDEA | 소스 연동 UML 클래스 다이어그램 | 구현 |
| IDEA-023 | IntelliJ IDEA | 모듈·패키지 의존성과 순환 분석 | 구현 |
| IDEA-024 | IntelliJ IDEA | 기호·패키지 이름 변경 | 부분 구현 |
| IDEA-025 | IntelliJ IDEA | 변수·상수·필드 추출 | 구현 |
| IDEA-026 | IntelliJ IDEA | 메서드 추출 | 구현 |
| IDEA-027 | IntelliJ IDEA | 변수·메서드 인라인 | 구현 |
| IDEA-028 | IntelliJ IDEA | 클래스·멤버 이동 | 부분 구현 |
| IDEA-029 | IntelliJ IDEA | Change Signature·파라미터 전파 | 부분 구현 |
| IDEA-030 | IntelliJ IDEA | Safe Delete | 부분 구현 |
| IDEA-031 | IntelliJ IDEA | 인터페이스 추출 | 구현 |
| IDEA-032 | IntelliJ IDEA | 멤버 Pull Up·Push Down | 구현 |
| IDEA-033 | IntelliJ IDEA | 리팩터링 미리보기·충돌·일괄 undo | 부분 구현 |
| IDEA-034 | IntelliJ IDEA | 람다·익명 클래스·루프 변환 | 구현 |
| IDEA-035 | IntelliJ IDEA | 생성자·접근자·equals·delegate 생성 | 구현 |
| IDEA-036 | IntelliJ IDEA | 실시간 Java/Kotlin 오류·null 검사 | 구현 |
| IDEA-037 | IntelliJ IDEA | Intention·Quick Fix·코드 정리 | 구현 |
| IDEA-038 | IntelliJ IDEA | 프로젝트 검사·스코프·심각도 프로필 | 구현 |
| IDEA-039 | IntelliJ IDEA | 중복 코드 감지 | 구현 |
| IDEA-040 | IntelliJ IDEA | 의존성 취약점·취약 API 사용 분석 | 구현 |
| IDEA-041 | IntelliJ IDEA | Qodana·CI 품질 게이트 연결 | 구현 |
| IDEA-042 | IntelliJ IDEA | Java 버전·JDK·언어 수준 | 구현 |
| IDEA-043 | IntelliJ IDEA | Java와 Kotlin 혼합 프로젝트 | 구현 |
| IDEA-044 | IntelliJ IDEA | Kotlin JVM 코드 지원 | 부분 구현 |
| IDEA-045 | IntelliJ IDEA | Kotlin Multiplatform·Compose 개발 | 부분 구현 |
| IDEA-046 | IntelliJ IDEA | Scala·sbt 개발 | 부분 구현 |
| IDEA-047 | IntelliJ IDEA | Groovy·Spock·콘솔 | 부분 구현 |
| IDEA-048 | IntelliJ IDEA | 외부 라이브러리 소스·바이트코드 디컴파일 | 구현 |
| IDEA-049 | IntelliJ IDEA | Scratch·JShell 실험 코드 | 구현 |
| IDEA-050 | IntelliJ IDEA | 어노테이션 프로세서·Lombok 생성 코드 | 구현 |
| IDEA-051 | IntelliJ IDEA | Spring Initializr 프로젝트 생성 | 구현 |
| IDEA-052 | IntelliJ IDEA | 기존 프로젝트 starter 편집 | 구현 |
| IDEA-053 | IntelliJ IDEA | Bean·Autowiring 분석·빠른 수정 | 부분 구현 |
| IDEA-054 | IntelliJ IDEA | Bean의 논리 구조·의존성 그래프 | 구현 |
| IDEA-055 | IntelliJ IDEA | Application Context·분석용 프로필 | 구현 |
| IDEA-056 | IntelliJ IDEA | Boot properties·YAML 메타데이터 | 구현 |
| IDEA-057 | IntelliJ IDEA | Actuator 런타임 Bean·Health·Mappings | 구현 |
| IDEA-058 | IntelliJ IDEA | Spring 디버거의 실제 설정값·출처 | 구현 |
| IDEA-059 | IntelliJ IDEA | Spring Data 파생 메서드·쿼리 | 구현 |
| IDEA-060 | IntelliJ IDEA | JPQL/HQL 작성·JPA Console | 구현 |
| IDEA-061 | IntelliJ IDEA | DB 스키마→JPA 엔티티·매핑 생성 | 구현 |
| IDEA-062 | IntelliJ IDEA | Persistence 트리·엔티티 관계도 | 구현 |
| IDEA-063 | IntelliJ IDEA | Hibernate 디버거·SQL 바인딩·N+1 | 구현 |
| IDEA-064 | IntelliJ IDEA | Spring Security 런타임 진단 | 부분 구현 |
| IDEA-065 | IntelliJ IDEA | MVC·WebFlux·Feign 엔드포인트 탐색 | 구현 |
| IDEA-066 | IntelliJ IDEA | Quarkus·MicroProfile | 부분 구현 |
| IDEA-067 | IntelliJ IDEA | Micronaut 개발 | 부분 구현 |
| IDEA-068 | IntelliJ IDEA | Jakarta EE·애플리케이션 서버 배포 | 부분 구현 |
| IDEA-069 | IntelliJ IDEA | Maven 프로젝트·목표·의존성 | 부분 구현 |
| IDEA-070 | IntelliJ IDEA | Gradle·Kotlin DSL·Task 탐색 | 구현 |
| IDEA-071 | IntelliJ IDEA | 모듈·혼합 빌드·프로젝트 인덱스 | 부분 구현 |
| IDEA-072 | IntelliJ IDEA | 증분 빌드·빌드 도구 위임 | 구현 |
| IDEA-073 | IntelliJ IDEA | 실행 구성·환경·사전 작업·공유 | 구현 |
| IDEA-074 | IntelliJ IDEA | 복수 서비스·Compound·실행 순서 | VS Code 재사용 |
| IDEA-075 | IntelliJ IDEA | JVM 시작·프로세스/원격 연결 | 구현 |
| IDEA-076 | IntelliJ IDEA | 조건·적중 횟수·로그 중단점 | 구현 |
| IDEA-077 | IntelliJ IDEA | 메서드·필드·행 내부 중단점 | 구현 |
| IDEA-078 | IntelliJ IDEA | 예외 종류·Caught/Uncaught 필터 | 구현 |
| IDEA-079 | IntelliJ IDEA | Smart Step·라이브러리 필터·비동기 스택 | 부분 구현 |
| IDEA-080 | IntelliJ IDEA | 표현식 평가·Watch·변수 수정·프레임 | 부분 구현 |
| IDEA-081 | IntelliJ IDEA | HotSwap·변경 클래스 재적용 | 구현 |
| IDEA-082 | IntelliJ IDEA | Java Stream 값 변환 시각화 | 구현 |
| IDEA-083 | IntelliJ IDEA | Kotlin 코루틴 상태·생성 스택 | 구현 |
| IDEA-084 | IntelliJ IDEA | JUnit·TestNG 발견·실행·디버그 | 구현 |
| IDEA-085 | IntelliJ IDEA | 테스트 결과·실패 diff·재실행 | 구현 |
| IDEA-086 | IntelliJ IDEA | 코드 커버리지·분기·테스트별 커버 | 구현 |
| IDEA-087 | IntelliJ IDEA | CPU·할당·JFR 프로파일 | 구현 |
| IDEA-088 | IntelliJ IDEA | 힙 덤프·메모리 누수 분석 | 구현 |
| IDEA-089 | IntelliJ IDEA | 스레드·가상 스레드·덤프 분석 | 구현 |
| IDEA-090 | IntelliJ IDEA | Git 변경·부분 stage·blame·기록 | VS Code 재사용 |
| IDEA-091 | IntelliJ IDEA | Changelist·작업 컨텍스트 | 구현 |
| IDEA-092 | IntelliJ IDEA | Shelf·Stash·선택 변경 보관 | 구현 |
| IDEA-093 | IntelliJ IDEA | Branch·Rebase·Merge 충돌 해결 | VS Code 재사용 |
| IDEA-094 | IntelliJ IDEA | Git Worktree·작업별 프로젝트 설정 | 구현 |
| IDEA-095 | IntelliJ IDEA | GitHub PR·GitLab MR 리뷰 | 구현 |
| IDEA-096 | IntelliJ IDEA | SSH 원격 개발 | 부분 구현 |
| IDEA-097 | IntelliJ IDEA | WSL 실행·개발 | 부분 구현 |
| IDEA-098 | IntelliJ IDEA | Dev Container 환경 | 구현 |
| IDEA-099 | IntelliJ IDEA | Docker·Compose·Registry 관리 | 부분 구현 |
| IDEA-100 | IntelliJ IDEA | Kubernetes·Helm·클러스터 탐색 | 부분 구현 |
| IDEA-101 | IntelliJ IDEA | 내장 터미널·셸·세션 | VS Code 재사용 |
| IDEA-102 | IntelliJ IDEA | HTTP 요청·환경·인증·검증 스크립트 | 구현 |
| IDEA-103 | IntelliJ IDEA | OpenAPI·Swagger 편집·미리보기·코드 생성 | 구현 |
| IDEA-104 | IntelliJ IDEA | GraphQL·gRPC·WebSocket 클라이언트 | 구현 |
| IDEA-105 | IntelliJ IDEA | IDE 안의 DB 연결·SQL·데이터 편집 | 구현 |
| IDEA-106 | IntelliJ IDEA | JavaScript·TypeScript·Node/브라우저 디버그 | VS Code 재사용 |
| IDEA-107 | IntelliJ IDEA | React·Angular·Vue 프레임워크 | 부분 구현 |
| IDEA-108 | IntelliJ IDEA | HTML·CSS/SCSS·Emmet·Preview | VS Code 재사용 |
| IDEA-109 | IntelliJ IDEA | Python 언어·환경·디버그 | 부분 구현 |
| IDEA-110 | IntelliJ IDEA | Jupyter Notebook·커널·셀 디버그 | 부분 구현 |
| IDEA-111 | IntelliJ IDEA | 원격 파일 배포·SFTP/FTPS/WebDAV | 구현 |
| IDEA-112 | IntelliJ IDEA | 설정·스타일·프로필 동기화 | VS Code 재사용 |
| IDEA-113 | IntelliJ IDEA | IDE 키맵·동작 컨텍스트·테마 | 부분 구현 |
| IDEA-114 | IntelliJ IDEA | 플러그인 설치·호환·갱신 | VS Code 재사용 |
| IDEA-115 | IntelliJ IDEA | AI 완성·채팅·프로젝트 문맥 | 구현 |
| IDEA-116 | IntelliJ IDEA | Air·ACP 에이전트·병렬 작업 | 구현 |
| IDEA-117 | IntelliJ IDEA | IDE 기능을 MCP 도구로 제공 | 구현 |
| IDEA-118 | IntelliJ IDEA | 프로젝트 신뢰·제한 모드 | 구현 |
| IDEA-119 | IntelliJ IDEA | 문자열 안 SQL/정규식/HTML 언어 주입 | 구현 |
| IDEA-120 | IntelliJ IDEA | JavaFX·FXML·Scene Builder·패키징 | 부분 구현 |
| DG-001 | DataGrip | MySQL 데이터 소스 생성·연결 검사 | 구현 |
| DG-002 | DataGrip | MariaDB 전용 지원 | 구현 |
| DG-003 | DataGrip | 다중 SQL·NoSQL DBMS 드라이버 | 구현 |
| DG-004 | DataGrip | 사용자 JDBC JAR·드라이버 클래스 추가 | 구현 |
| DG-005 | DataGrip | 드라이버 버전 교체·추가 라이브러리 | 구현 |
| DG-006 | DataGrip | 사용자·비밀번호·무인증 모드 | 구현 |
| DG-007 | DataGrip | 비밀정보 저장·저장하지 않기 | 구현 |
| DG-008 | DataGrip | TLS CA·호스트 검증 | 구현 |
| DG-009 | DataGrip | 클라이언트 인증서·truststore | 구현 |
| DG-010 | DataGrip | SSH 터널·키·agent 인증 | 구현 |
| DG-011 | DataGrip | Unix socket·Windows named pipe | 구현 |
| DG-012 | DataGrip | 클라우드 DB 접속·토큰 인증 범위 | 부분 구현 |
| DG-013 | DataGrip | 초기 SQL·keep-alive·idle timeout | 구현 |
| DG-014 | DataGrip | 연결 그룹·환경 색상 | 구현 |
| DG-015 | DataGrip | 연결 복제·가져오기·공유 | 구현 |
| DG-016 | DataGrip | 연결·테이블 읽기 전용 보호 | 구현 |
| DG-017 | DataGrip | introspection 대상 schema 선택 | 구현 |
| DG-018 | DataGrip | 로컬 메타데이터 cache·오프라인 재사용 | 구현 |
| DG-019 | DataGrip | 전체·증분·객체별 refresh | 구현 |
| DG-020 | DataGrip | 이름 우선·지연 상세 로딩 | 구현 |
| DG-021 | DataGrip | 시스템 schema minicatalog | 구현 |
| DG-022 | DataGrip | 객체 이름·DDL·파일 검색 | 구현 |
| DG-023 | DataGrip | DDL·object source 보기 | 구현 |
| DG-024 | DataGrip | 루틴·인덱스·트리거·MariaDB package | 구현 |
| DG-025 | DataGrip | 실제 FK 없는 관계 정의 | 구현 |
| DG-026 | DataGrip | virtual view·virtual column | 구현 |
| DG-027 | DataGrip | schema-aware 이름·열 완성 | 구현 |
| DG-028 | DataGrip | FK 기반 JOIN/ON 자동 생성 | 구현 |
| DG-029 | DataGrip | SELECT·INSERT·GROUP BY 필드 목록 완성 | 구현 |
| DG-030 | DataGrip | alias·약어·함수 구문 완성 | 구현 |
| DG-031 | DataGrip | MySQL/MariaDB dialect별 구문·키워드 | 구현 |
| DG-032 | DataGrip | 파일·폴더별 SQL resolution scope | 구현 |
| DG-033 | DataGrip | 현재 스크립트의 DDL 변화 인식 | 구현 |
| DG-034 | DataGrip | 실시간·범위별 정적 검사 | 구현 |
| DG-035 | DataGrip | 위험한 UPDATE/DELETE 경고 | 구현 |
| DG-036 | DataGrip | schema-aware quick-fix·의도 동작 | 구현 |
| DG-037 | DataGrip | 테이블·열·alias 의미적 Rename | 구현 |
| DG-038 | DataGrip | 의미적 Find Usages·영향 추적 | 구현 |
| DG-039 | DataGrip | SQL 참조→정의·DDL·빠른 설명 | 구현 |
| DG-040 | DataGrip | dialect별 SQL formatting | 구현 |
| DG-041 | DataGrip | live template·snippet·문맥 변수 | 구현 |
| DG-042 | DataGrip | 문자열 안 SQL/JSON 언어 주입 | 구현 |
| DG-043 | DataGrip | 쿼리 parameter 입력·재사용 | 구현 |
| DG-044 | DataGrip | 현재 문장·선택 SQL 실행 | 구현 |
| DG-045 | DataGrip | 전체 스크립트·batch·오류 처리 | 구현 |
| DG-046 | DataGrip | 같은 세션·temporary table 상태 유지 | 구현 |
| DG-047 | DataGrip | 세션 공유·전용·introspection 분리 | 구현 |
| DG-048 | DataGrip | 수동 commit/rollback·auto-commit 전환 | 구현 |
| DG-049 | DataGrip | 트랜잭션 격리 수준 선택 | 구현 |
| DG-050 | DataGrip | 실행 취소·connection 종료 | 구현 |
| DG-051 | DataGrip | 쿼리 이력·검색·재실행 | 구현 |
| DG-052 | DataGrip | 전체 SQL 로그·메타데이터 요청 기록 | 구현 |
| DG-053 | DataGrip | 즐겨찾기·저장 쿼리·다시 실행 | 구현 |
| DG-054 | DataGrip | 여러 result set·탭 유지·고정 | 구현 |
| DG-055 | DataGrip | EXPLAIN 원본·tree/table | 구현 |
| DG-056 | DataGrip | 시각 실행 계획·cost graph | 구현 |
| DG-057 | DataGrip | EXPLAIN ANALYZE 실제 실행 통계 | 구현 |
| DG-058 | DataGrip | 편집기 안 결과·SQL notebook 대안 | 구현 |
| DG-059 | DataGrip | 페이지 이동·row limit·지연 조회 | 구현 |
| DG-060 | DataGrip | 서버 정렬·다중 column 정렬 | 구현 |
| DG-061 | DataGrip | WHERE·column filter·검색·저장 filter | 구현 |
| DG-062 | DataGrip | 셀 직접 편집·저장·충돌 확인 | 구현 |
| DG-063 | DataGrip | pending DML 미리보기·변경 되돌리기 | 구현 |
| DG-064 | DataGrip | 행 추가·삭제·복제·일괄 붙여넣기 | 구현 |
| DG-065 | DataGrip | NULL·긴 text·JSON·binary 값 편집 | 구현 |
| DG-066 | DataGrip | FK 따라 관련 행으로 이동 | 구현 |
| DG-067 | DataGrip | record·tree·text·transpose 보기 | 구현 |
| DG-068 | DataGrip | 컬럼 고정·숨김·순서·폭 조절 | 구현 |
| DG-069 | DataGrip | CSV/TSV·clipboard 내보내기 | 구현 |
| DG-070 | DataGrip | INSERT/JSON/Excel 등 출력 형식 | 구현 |
| DG-071 | DataGrip | 사용자 data extractor 스크립트 | 구현 |
| DG-072 | DataGrip | CSV/Excel import·column/type mapping | 구현 |
| DG-073 | DataGrip | 다른 DB/table로 데이터 복사 | 구현 |
| DG-074 | DataGrip | native dump·restore 도구 통합 | 구현 |
| DG-075 | DataGrip | table·result dataset 비교·sync | 구현 |
| DG-076 | DataGrip | 그리드 결과 차트·집계 | 구현 |
| DG-077 | DataGrip | 지리 데이터 지도 보기 | 구현 |
| DG-078 | DataGrip | table create/alter 시각 designer | 구현 |
| DG-079 | DataGrip | PK·FK·index·제약조건 편집 | 구현 |
| DG-080 | DataGrip | 사용자·역할·권한 관리 | 구현 |
| DG-081 | DataGrip | routine·view source 수정·deploy | 구현 |
| DG-082 | DataGrip | 서로 다른 서버 schema/object 구조 diff | 구현 |
| DG-083 | DataGrip | 선택 변경의 migration DDL 생성·검토·실행 | 부분 구현 |
| DG-084 | DataGrip | DDL 파일을 가상 DB 의미 모델로 사용 | 구현 |
| DG-085 | DataGrip | DB schema→정렬된 DDL 파일·VCS | 구현 |
| DG-086 | DataGrip | live schema ERD 생성·관계 탐색 | 구현 |
| DG-087 | DataGrip | diagram 출력·레이아웃 보존 | 구현 |
| DG-088 | DataGrip | SQL 파일 Git·diff·변경 검토 | VS Code 재사용 |
| DG-089 | DataGrip | schema 문맥의 자연어 SQL·설명 | 구현 |
| DG-090 | DataGrip | 외부 AI용 DB MCP·권한·결과 제공 | 구현 |
| DG-091 | DataGrip | 2026.3 Air·여러 agent 작업 검토 | 구현 |
| DG-092 | DataGrip | 서로 다른 data source의 cross-database SQL | 구현 |
| DG-093 | DataGrip | DuckDB dialect·함수·introspection | 구현 |
| DG-094 | DataGrip | 미실행 SQL·최근 파일·Local History 복원 | 구현 |
| DG-095 | DataGrip | DataGrip 전체 창·도구창의 정확한 배치 | 호스트 구조 제약 |
| DG-096 | DataGrip | SQL 단축키·명령·결과 panel 이동 | 구현 |
