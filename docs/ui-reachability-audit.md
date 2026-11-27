# 설치 후 화면과 기능 진입점 점검

2026-11-27 기준 Rocketbrain 0.177.0 설치 패키지와 216개 기능표를 대조했다. 각 행은 화면, 팔레트, 단축키, VS Code 기본 UI 또는 별도 실행 경로를 기록한다. 마지막 열의 검증은 기능표에 보존된 이력이며, 이번에 실제 입력을 재현한 범위는 아래에 따로 적는다. 명령은 팔레트에서 `Rocketbrain:`을 앞에 붙여 검색할 수 있다.

0.177.0의 [배포 소스](https://github.com/Fenrindale/Rocketbrain/tree/ff17d43aba142984c7ff917b184dbfd2ada6ab14), [확장 메뉴 정의](../package.json), [기능별 판정](feature-status.json), [설치 검증 요약](verification.json)을 근거로 삼았다. Craft Anything CLI로 확인한 0.177.0 패키지는 39개 파일을 담고 있다.

## Java 정의 이동

최초 비교표부터 IDEA-015에 정의·구현 이동이 있었다. 0.177.0은 독립 Java 엔진의 정의 공급자를 실제 파일의 Java 편집기에 연결한다. 0.63 설치 시험은 가져온 Spring 프로젝트에서 선언·오버로드의 구현·상위 메서드를 확인했다. 별도의 호스트 시험은 VS Code 공급자 API를 통해 다른 Java 파일과 JDK 소스로 이동할 수 있음을 확인했다. 두 시험은 최초 실행 상태의 마우스 Ctrl+클릭을 직접 보내지 않았다. [선언 이동 시험](../test/java-symbol-navigation-host.js) · [VS Code 공급자 시험](../test/java-host.js)

Ctrl+클릭과 F12는 같은 정의 이동 기능을 제공한다. 구현 목록은 Ctrl+F12, 사용처는 Shift+F12에서 확인한다. VS Code의 다중 커서 설정을 Ctrl+클릭으로 바꾸면 정의 이동은 Alt+클릭으로 바뀐다. [VS Code 코드 탐색](https://code.visualstudio.com/docs/editing/editingevolved) · [다중 커서 설정](https://code.visualstudio.com/docs/editing/codebasics#_multicursor-modifier)

이번에 VS Code 1.145.3에 0.177.0 VSIX를 설치해 준비된 Java 엔진에서 실제 Ctrl+클릭과 F12를 각각 입력했다. 두 입력 모두 Maven 예제의 App.java 호출 위치에서 Greeter.java의 선언을 열었다. 별도의 독립 JDT LS 1.63.0 시험에서 오버로드 선언, 구현, 사용처, 상위 메서드와 JDK 소스도 확인했다. [Maven 예제](../test/fixtures/java/maven/src/main/java/dev/rocketbrain/App.java) · [JDT 시험](../test/java-symbol-navigation.test.js)

같은 0.177.0 환경에서 엔진이 시작 중일 때 입력한 Ctrl+클릭은 선언을 열지 않았다. 엔진과 프로젝트가 준비된 뒤에는 같은 예제에서 이동했다. 이 재현 범위는 해당 설치와 Maven 예제다.

0.177.1은 Java Projects에 설치·시작·설정 진입점을 추가했다. 바로 시작한 엔진은 Starting, JDT 연결 후 프로젝트 분석 중에는 Indexing, 서비스 준비 후에는 Ready를 표시한다. 실제 Java 파일의 정의 요청이 들어오면 시작과 프로젝트 준비를 기다리는 경로를 추가했다. [설치와 시작](../src/java/index.js) · [자동 시작](../src/java/startup.js)

최종 0.177.1 VSIX를 설치한 별도 VS Code 1.145.3에서 미설정 상태의 Java Projects 설치 진입점을 확인했다. 설정까지 끝낸 새 창에서는 Starting일 때 보낸 첫 정의 공급자 API 요청이 약 8.9초 뒤 App.java의 호출과 일치하는 Greeter.java 선언을 반환했다. Ready 이후 실제 Ctrl+클릭과 F12도 각각 같은 선언을 열었다. **Starting에 누른 첫 실제 Ctrl+클릭은 이동하지 않았다.** 마우스로 이동할 때는 Ready 표시가 나온 뒤 다시 누르면 된다. [검증 기록](verification.json)

0.177.1의 Spring·JPA 공급자는 일반적인 `receiver.method(...)`의 메서드 이름에서 해당 워크스페이스 분석을 기다리지 않는다. 어노테이션 값, Spring Data의 메서드 선언과 JPQL 위치는 기존 분석을 거친다. 시작과 공급자 회귀 검사 21개가 통과했다. 대규모 프로젝트에서의 응답 시간은 후속 실제 입력 시험에 남겼다. [위치 판정](../src/java/definition-position.js) · [공급자 회귀 시험](../test/java-definition-position.test.js)

## DataGrip 샘플 콘솔

별도 VS Code 1.145.3에 0.177.0 VSIX를 설치했다. 상태 표시줄의 DataGrip을 누르고 팔레트에서 Open SQL Console을 실행했다. 샘플 `SELECT * FROM projects;` 안에 커서를 두고 실제 Ctrl+Enter를 눌렀을 때 Query Results에 3행이 나왔고 Database 트리에서 projects가 보였다. 같은 콘솔의 세미콜론 바로 뒤에서는 결과가 나오지 않았다. 문장 선택 함수는 그 위치에서 뒤따르는 설명 주석을 반환했다. 이번 입력 시험은 로컬 샘플에서 진행했다. [문장 선택](../src/sql.js) · [콘솔과 결과 표시](../src/database-workbench.js)

## 우선순위

| 우선순위 | 항목 | 확인한 사용자 경로 | 남은 수정·검증 |
| --- | --- | --- | --- |
| P0 | IDEA-002 · IDEA-015 · IDEA-071 | 0.177.1에서 설치 진입점, 시작 중 정의 공급자 요청, Ready 뒤 실제 Ctrl+클릭과 F12를 확인했다. | Starting에서 누른 실제 Ctrl+클릭은 이동하지 않았다. 프로젝트가 준비되기 전의 마우스 입력을 검증 범위에 남겼다. |
| P0 | IDEA-015 · IDEA-053 · IDEA-059 | 0.177.0의 Spring/JPA Java 정의 공급자가 일반 호출에서도 초기 분석을 기다릴 수 있다. 0.177.1의 위치 판정은 해당 대기를 줄이고 기존 Spring/JPA 위치를 보존한다. | 일반 Java 메서드와 지원 Spring/JPA 위치에서 처음 열 때의 응답 시간과 목적지를 검증한다. |
| P0 | DG-031 · DG-034 · DG-035 | 카탈로그가 있는 조건에서 일반 SQL을 열었을 때 문제 목록이 비어 있었고, 편집 이벤트 뒤에는 WHERE 누락과 열 이름 진단이 나왔다. | 연 직후에 편집 없이 진단이 나타나는 경로를 검증한다. [문서 열기 처리](../src/db/sql-vscode.js) |
| P0 | DG-027 · DG-028 · DG-029 · DG-030 · DG-033 · DG-034 · DG-037 · DG-039 · DG-047 | 전용 프로필 콘솔과 프로필에 묶은 SQL 파일은 실행 연결을 가진다. 공용 활성 카탈로그를 사용하는 의미 분석 경로에서는 제외된다. | 정확히 연결된 프로필 단위의 완성·정의·진단을 제공하고 동명 객체가 서로 다른 스키마에 있을 때 목적지를 검증한다. [SQL 분석](../src/db/sql-vscode.js) |
| P0 | DG-044 · DG-096 | 오프라인 데모에서 세미콜론 바로 뒤에 커서를 두고 Ctrl+Enter를 누르자 뒤따르는 주석 범위를 선택해 쿼리를 실행하지 않았다. | 문장 구분 기호 바로 뒤에서도 사용자에게 보이는 문장이 실행되도록 하고, 다음 문장과 주석 경계를 검증한다. [문장 위치 처리](../src/sql.js) |
| P1 | IDEA-065 · IDEA-070 | Feign 안내의 Spring Endpoints와 Gradle 안내의 Discover Build Tasks 표기가 실제 팔레트 이름과 다르다. Choose Build Task는 목록을 채우고 Run Build Task가 실제 선택을 받는다. | 처음 보는 사용자가 설명과 동일한 명령으로 진입할 수 있게 이름과 동작을 맞춘다. [Feign 안내](spring-feign-contracts.md) · [Gradle 처리](../src/java/workbench.js) |
| P1 | IDEA-076 · IDEA-077 · IDEA-084 · IDEA-113 | 여백·Variables·Testing의 기본 동작과 팔레트의 확장 기능이 나뉜다. IntelliJ 모드의 테스트 탐색은 Java Projects 더 보기 메뉴에 있다. 키보드 프로필은 별도 선택이다. | 설치 직후 테스트 런타임을 찾고, 실제 Variables 메뉴에서 필드 중단을 설정하며, 기본 입력과 프로필 입력을 함께 검증한다. |
| P1 | DG-001 · DG-006 · DG-012 · DG-039 · DG-044 · DG-062 · DG-096 | 빠른 연결과 저장 프로필 설정이 두 경로다. SQL 정의 공급자·실행·결과 그리드에 개별 검증 이력이 있다. | 빈 연결 화면 안내를 보강하고 한 세션에서 SQL 열기, Ctrl+클릭, Ctrl+Enter, 결과 이동을 연속으로 재현한다. |
| P2 | IDEA-001 · IDEA-087 · IDEA-089 · IDEA-117 · IDEA-120 · DG-095 | 호스트 창 배치, 일부 JFR/스레드 시각화, MCP 수동 설정, 범위가 정해진 JavaFX 편집 흐름은 화면별 제약과 전제 조건이 있다. | 지원하는 화면과 조건을 도구 이름과 진입점에서 확인할 수 있게 한다. |

## 기능별 화면

상태는 기존 가중 집계의 판정이다. 화면이나 명령의 존재, 소스 연결, 실제 입력 시험은 각 행의 근거를 따로 확인한다. 명령은 해당 파일 종류, 신뢰 상태, 활성 연결이나 실행 환경에 따라 표시된다.

### IntelliJ IDEA

#### 작업 공간·편집기

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-001 | IDE 전체 배치·도킹·네이티브 화면 · 호스트 구조 제약 | IntelliJ IDEA status item and corresponding palette command. Project, Java Projects, Spring & JPA Analysis and Kotlin Coroutines views. Show All Tools restores the combined views. | v0.177.0 설치 시험 · 상태 표시줄 버튼, 작업 공간별 모드 저장, Java·Spring 사이드바 표시 조건을 확인한다. [검증 기록](verification.json) |
| IDEA-002 | 프로젝트·패키지·모듈 탐색 · 구현 | Java Projects tree after JDT project import. Select a source or reveal a dependency/build output from the related tree items. Refresh Java Projects from the view title or palette. | v0.91 설치 시험 · 실제 Maven reactor와 Gradle composite에서 클래스 6개를 빌드했다. 설치된 트리에서 생성 소스와 테스트 출력, 정확히 연결한 두 모듈 의존성을 열었다. [시험 기록](../test/java-project-layout-host.js) |
| IDEA-003 | Search Everywhere 통합 검색 · 구현 | Project view title, Search Everywhere palette action and default Ctrl+Shift+A. The DB search prefix depends on an active live catalog. | v0.90 설치 시험 · 설치판에서 실제 Spring Java 기호와 원문, 설정과 명령, 동일 검색의 파일·로컬 커밋, 브랜치 리비전, 실제 DB 객체의 원문을 열었다. 파일·설정·Git 인덱스는 보존했고 연결을 끊은 DB 결과 열기를 거부했다. [시험 기록](../test/search-everywhere-host.js) |
| IDEA-004 | 최근 파일·편집 위치·뒤로/앞으로 · VS Code 재사용 | VS Code Go Back/Forward and open-editor history. Rocketbrain Recent Files in palette, keybindings and Context Actions where workspace exists. | VS Code 기본 기능 · 파일·기호·명령 검색과 최근 파일의 구현/기존 검증 범위. 패키지·모듈 논리 탐색은 제외한다. [관련 소스](../src/navigation.js) |
| IDEA-005 | 다중 커서·열 선택·일괄 편집 · VS Code 재사용 | VS Code multi-cursor and column selection editor gestures, native selection and edit commands. Modifier is a VS Code setting. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-006 | 의미 기반 선택 확장·축소 · 구현 | Expand/Shrink Semantic Selection palette actions and default Ctrl+K Ctrl+Shift+Right/Left. Trusted Java, Kotlin and supported SQL editor languages. | v0.73 설치 시험 · 두 실제 Spring 환경의 JDT Java, Kotlin Gradle 서버와 SQL 편집기에서 선택 경계 및 확장·축소를 확인했다. 커서 수와 방향 복원, 수동 이동 시 선택 이력 초기화, 문장 경계 및 원본 보존을 검증했다. [시험 기록](../test/semantic-selection-host.js) |
| IDEA-007 | 문맥·타입 기반 코드 완성 · 구현 | Native completion suggestions in Java after JDT setup. Complete Java Value by Expected Type in the Java editor context menu or palette. Spring qualifier completion at a resolved constructor parameter. | v0.93 설치 시험 · 실제 Spring 프로젝트의 미완성 @Qualifier에서 타입·프로필과 별칭을 비교하고 설치판의 편집과 Undo를 확인했다. [시험 기록](../test/spring-qualifier-completion-host.js) |
| IDEA-008 | 파라미터 정보·빠른 문서 · 구현 | Native hover/parameter hints plus Quick Code Documentation and Show Call Signatures palette actions in a trusted Java/Kotlin editor. | v0.74 설치 시험 · 두 설치 환경에서 JDT Java·Kotlin Gradle 서버의 실제 오버로드, 활성 인수와 Kotlin 매개변수 KDoc을 확인했다. 독립 JDT 검증에서는 소스 없는 JAR의 매개변수 이름과 시그니처를 관찰했다. [시험 기록](../test/code-information-host.js) |
| IDEA-009 | Live Templates·Postfix 완성 · 구현 | Insert Java Live Template in palette. Java lexical postfix completions in Java's native suggestions for supported expressions. | v0.30 설치 시험 · 실제 VS Code·Spring에서 사용자 정의 Java 템플릿과 편집 가능한 자리표시자를 삽입하고 postfix 표현식의 컴파일·실행을 확인했다. [시험 기록](../test/java-editing.test.js) |
| IDEA-010 | 코드 포맷·EditorConfig · 구현 | Native Format Document/Format Selection and Preview Java Formatting or Preview Kotlin Formatting in palette. Workspace EditorConfig and active appropriate runtime. | v0.67 설치 시험 · 두 DB가 연결된 Spring 워크스페이스에서 Kotlin 전체·선택 포맷, 설정 파일 두 개, 공백 2칸과 탭 4칸, 원문 리터럴, CRLF 및 Undo·Redo, 변경 설정의 검토 거부를 확인했다. 기존 Java 검증이 동일 포맷 수명주기를 확인했다. [시험 기록](../test/kotlin-formatting-host.js) |
| IDEA-011 | 자동 import·사용하지 않는 import 정리 · 구현 | Java Quick Fix/Organize Imports and Add Java Type Import/Add Java Static Member Import palette actions. Selection and compiler attribution constrain applicable fixes. | v0.85 설치 시험 · 두 실제 Spring 환경의 설치판에서 Math와 StrictMath 제안, Math의 정수·실수 오버로드, Integer 필드와 직접 지정한 프로젝트 필드를 확인했다. 기존 임포트와 디스크를 보존하고 Undo로 되돌렸다. [시험 기록](../test/java-static-import-host.js) |
| IDEA-012 | 인레이 힌트·의미 강조 · 구현 | Inline inlay hints, Configure Code Hints and Inspect Semantic Token palette actions for Java and Kotlin. | v0.76 설치 시험 · 설치판에서 실제 Java와 Kotlin의 전체·리터럴·타입·끄기 설정과 토큰을 확인했다. 힌트 호출 중 원본 코드가 바뀌지 않았다. [시험 기록](../test/code-hints-host.js) |
| IDEA-013 | 로컬 변경 이력·삭제 복구 · VS Code 재사용 | VS Code Explorer Timeline and local history. Separate Rocketbrain Restore Deleted Java File command is Java-specific. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-014 | 새 파일 템플릿 · 구현 | New Java File from Template from Explorer folder right-click or palette. Trusted project/source root selection and configured copyright profiles. | v0.75 설치 시험 · 두 실제 Spring 작업공간에서 일치하는 빌드·소스 루트 프로필로 Java 컴포넌트를 만들었다. JDT로 컴파일하고 같은 클래스패스에서 실행해 한글·따옴표·정수 값을 읽었다. 범위 불일치, 잘못된 식별자와 중복 파일은 거부했다. [시험 기록](../test/template-profiles-host.js) |

#### 탐색·구조 분석

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-015 | 선언·타입·구현·상위 메서드 이동 · 구현 | Native Go to Definition and Go to Implementation from Java editor with JDT ready. Right-click Go to Code Target or use palette and choose Declaration, Type Declaration, Implementations or Super Method. Dedicated Go to Java Super Method is also in palette. | v0.63 설치 시험 · 두 실제 Spring DB의 설치 환경에서 Java 오버로드의 여러 구현, 상위 메서드와 JDK 소스, 대상 변경 거부, Kotlin 수신 타입별 동명 확장 함수 선언 두 곳을 확인했다. · 0.177.1에서 시작 중 요청한 정의 공급자 API가 Greeter 선언을 반환했다. Ready 이후 실제 Ctrl+클릭·F12가 이동했고, Starting 상태에서 처음 누른 마우스 입력은 이동하지 않았다. [시험 기록](../test/java-symbol-navigation-host.js) |
| IDEA-016 | Find Usages·참조 탐색 · 구현 | Find JVM & Spring Usages via editor right-click, palette, Context Actions and optional key profile. Native reference UI is also available for JDT Java. | v0.65 설치 시험 · 두 Spring DB 설치 환경에서 Java 오버로드 참조 두 곳과 파일 범위, Spring XML과 Java의 양방향 클래스 사용처, 설정 키 사용처 두 곳, Kotlin 수신 타입별 동명 참조 및 변경 거부를 확인했다. [시험 기록](../test/java-usage-search-host.js) |
| IDEA-017 | 호출 계층 · 구현 | Explore Java Call Hierarchy from right-click or palette, and native call hierarchy where JDT supplies it. Trusted Java editor. | v0.29 설치 시험 · 최종 설치본에서 실제 Spring 메서드의 양방향 호출, 공통 호출 위치, int·String 오버로드와 네이티브 호출 트리를 확인했다. [시험 기록](../test/java-navigation-host.js) |
| IDEA-018 | 타입·상속 계층 · 구현 | Explore Java Type Hierarchy from right-click or palette. Trusted JDT source selection. | v0.29 설치 시험 · 최종 설치본에서 실제 Spring 프로젝트의 JPA 부모·자식과 인터페이스 구현을 양방향으로 확인하고 네이티브 타입 트리를 열었다. [시험 기록](../test/java-navigation-host.js) |
| IDEA-019 | Structure·현재 파일 기호 · 구현 | File Structure from right-click, palette, Context Actions and key profile. Native Outline for supported JDT file symbols. | v0.70 설치 시험 · 두 Spring 환경에서 제네릭 상속 멤버와 복합 필드 위치, 바이너리 항목, 이름 있는 중첩·지역 타입과 익명 타입 두 개, 변경 선언 거부를 실제 버퍼에서 확인했다. [시험 기록](../test/java-inherited-structure-host.js) |
| IDEA-020 | 정적 Data Flow to/from Here · 구현 | Trace Java Local Value and Trace Java Value Across Calls via palette on trusted saved/current applicable Java source. Choose direction and event in Quick Picks. | v0.97 설치 시험 · 두 DB에 연결한 실제 Spring 작업 영역에서 분기 결합과 호출 인자 필터, null 축소, 정확한 조건 위치, 변경 후 재분석을 확인했다. [시험 기록](../test/java-branch-flow-host.js) |
| IDEA-021 | 구조 검색·치환 · 구현 | Search or Replace Java Structure via palette. Choose Java scope, pattern, types, optional replacement, and reviewed matches. | v0.41 설치 시험 · 두 Spring 프로젝트에서 타입이 맞는 패턴을 프로젝트 3곳·개별 파일 1곳에서 찾았다. 두 파일 치환과 빌드, 호환되지 않는 치환, 평가 동작이 바뀌는 캡처, 원본 변경의 거부를 확인했다. [시험 기록](../test/java-structural-search-host.js) |
| IDEA-022 | 소스 연동 UML 클래스 다이어그램 · 구현 | Show Java Class Diagram via palette on trusted Java scope. Interactive diagram with source/relations and Mermaid. | v0.92 설치 시험 · 설치판에서 Spring JdbcTemplate 메서드 관계와 필드 연관을 표현하고 다른 Date 타입으로 바꾼 뒤 오래된 탐색을 거부하고 재계산해 소스를 열었다. [시험 기록](../test/java-diagram-relationships-host.js) |
| IDEA-023 | 모듈·패키지 의존성과 순환 분석 · 구현 | Inspect Java Dependencies via palette. Select imported project/report then inspect paths, types, edges and build declarations. | v0.96 설치 시험 · 두 모듈의 실제 소스·선언 순환을 검증했다. 정확한 pick(int)과 Maven 선언을 열고 소스 수정 후 소스 순환만 사라짐을 확인했다. [시험 기록](../test/java-attributed-dependencies-host.js) |

#### 리팩터링·코드 생성

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-024 | 기호·패키지 이름 변경 · 구현 | Native Rename Symbol. Rename Java Package and Review Public Java Type Rename via palette for review/diff and cross-language guards. | v0.158 런타임 · 실제 JDT·Kotlin 언어 서버·Javac로 파일과 참조를 검증했다. Gradle로 다시 빌드한 Spring 애플리케이션이 두 DB에서 같은 결과를 냈다. 허용된 JPMS 소비자의 공개·반사 접근은 유지됐고 외부 모듈의 접근은 거부됐다. [시험 기록](../test/java-jpms-qualified-rename.test.js) |
| IDEA-025 | 변수·상수·필드 추출 · 구현 | Extract Java Local Variable, Extract Java Field and Extract Java Constant via palette on a trusted Java selection. Available JDT editor code actions may surface the extraction too. | v0.64 설치 시험 · 두 Spring DB 설치 환경에서 실제 JDT 지역 변수·필드 선언, 이름 충돌과 오래된 계획 차단, 사용처 2·3개, 한 버퍼 편집·Undo·디스크 보존을 확인했다. 기존 상수 흐름은 컴파일러 회귀 검사에 포함했다. [시험 기록](../test/java-named-extraction-host.js) |
| IDEA-026 | 메서드 추출 · 구현 | Extract Java Method via palette and refactor code action around applicable Java selection. | v0.85 설치 시험 · 설치판에서 final String과 수정 가능한 int를 검증한 Java record로 되돌리고 원래 범위의 선언을 복원했다. 컴파일 타임 상수와 경계를 벗어나는 제어는 거부했다. 실제 JDK 실행의 결과와 하나의 Undo를 확인했다. [시험 기록](../test/java-extract-method-host.js) |
| IDEA-027 | 변수·메서드 인라인 · 구현 | Inline Java Method Call via palette and Java refactor code actions. Inline local variable comes from JDT refactor actions. | v0.89 설치 시험 · 실제 두 Spring JDK 설치판에서 암시적·명시적 this와 생성한 수신자의 결과를 대조했다. 네 실행 출력, 인수의 부작용 순서, 무효화 검사와 한 번의 Undo를 확인했다. [시험 기록](../test/java-instance-inline-host.js) |
| IDEA-028 | 클래스·멤버 이동 · 구현 | Palette commands Move Java Class File, Move Java Class Across Projects, Move Java Inner Class to New File, Move Java Static Member, Move Java Instance Method, Move Java Package. Target and diff selection follow. | v0.160 런타임 · Maven 3.9.11과 실제 JDT에서 서비스 소유 모듈, 두 제공자 모듈, 소비자 모듈을 가져왔다. 이동 전후 생성자·정적 팩터리 제공자의 결과 17·29와 두 DB의 Spring JDBC 결과 46이 일치했다. [시험 기록](../test/java-jpms-service-package-move.test.js) |
| IDEA-029 | Change Signature·파라미터 전파 · 구현 | Change Java Signature via palette and optional Java key profile. Pick operation, including Add Parameter and Keep Old Overload, and inspect preview. | v0.158 런타임 · 실제 JDT와 Javac로 기존과 새 JVM 서명 및 직접 호출 두 곳을 확인했다. 재컴파일하지 않은 클라이언트가 새 JAR에서 동작했고 소스를 다시 빌드한 Spring 프로젝트는 두 DB에서 동일한 결과를 냈다. [시험 기록](../test/java-signature-compatibility.test.js) |
| IDEA-030 | Safe Delete · 구현 | Safe Delete Java Declaration via palette and optional Java key profile. Applies only when declaration/usage review admits the edit. | v0.156 런타임 · 실제 JDT와 Javac가 선언과 직접 호출 두 곳을 확인했다. Spring 생성자 주입과 남은 인자의 평가 순서가 유지됐고 두 DB에서 JDBC 결과가 일치했다. 누락된 엔진 참조, 부작용, 언박싱, 오버로드와 명시·암시 주입을 거부했다. [시험 기록](../test/java-constructor-safe-delete.test.js) |
| IDEA-031 | 인터페이스 추출 · 구현 | Extract Java Interface via palette at selected Java method with review. | v0.42 설치 시험 · 두 실제 Spring 픽스처에서 제네릭 경계를 보존하고 호환되는 호출부만 전환했다. 동명 파일 충돌 거부, 새 파일 저장, 기존 버퍼의 수동 저장과 빌드를 확인했다. [시험 기록](../test/java-extract-interface-host.js) |
| IDEA-032 | 멤버 Pull Up·Push Down · 구현 | Pull Up Java Members or Push Down Java Members via palette on trusted Java source. Pick target and review. | v0.43 설치 시험 · 두 실제 Spring 픽스처에서 메서드·상수를 양방향으로 옮겼다. 호출부와 형제 클래스 유지, 문서 주석, 변경 원본 거부와 새 빌드를 확인했다. [시험 기록](../test/java-member-hierarchy-host.js) |
| IDEA-033 | 리팩터링 미리보기·충돌·일괄 undo · 구현 | Review Public Java Type Rename, Refactor Java Selection with Preview and specialized reviewed refactor commands. Diff editor, option selection and normal Undo after apply. | v0.158 런타임 · 두 DB에서 선택 주석만 반영한 경우와 주석 없이 필수 변경을 적용한 경우의 Spring 결과가 일치했다. 선택 창과 확인 창의 취소, 변경 이후 파일 수정 감지, 필수 변경 제거 거부를 확인했다. [시험 기록](../test/java-type-rename.test.js) |
| IDEA-034 | 람다·익명 클래스·루프 변환 · 구현 | Convert Java Lambda, Anonymous Class or Loop via palette on trusted Java context. | v0.98 설치 시험 · 네 루프를 VS Code에서 적용한 후 매번 실제 Spring 프로젝트를 빌드했다. 세 개의 안전하지 않은 경우와 저장 전 원본 보존을 확인했다. [시험 기록](../test/java-enhanced-iteration-host.js) |
| IDEA-035 | 생성자·접근자·equals·delegate 생성 · 구현 | Generate Java Members via Java right-click Refactor group or palette. Choose generator and members, then review. | v0.30 설치 시험 · 실제 Spring 프로젝트에서 일곱 멤버를 생성했다. 충돌 거부, 취소, 실행 취소·다시 실행, 컴파일된 접근·동등성과 위임 반환값 42를 확인했다. [시험 기록](../test/java-editing-host.js) |

#### 검사·품질·보안

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-036 | 실시간 Java/Kotlin 오류·null 검사 · 구현 | Problems and editor squiggles with Java/Kotlin language server active. Configure Java Null Checks from palette in trusted workspace. | v0.77 설치 시험 · 가져온 실제 Spring Java 프로젝트에서 null 역참조, 반환 계약, 자원 누수 진단의 위치를 검증했다. 실제 Kotlin 프로젝트의 UNSAFE_CALL을 확인했다. 저장 전 수정과 실행 취소에서 두 진단이 갱신됐다. [시험 기록](../test/null-checks-host.js) |
| IDEA-037 | Intention·Quick Fix·코드 정리 · 구현 | Java Quick Fix via Alt+Enter/code action and Review Java File Cleanup via right-click or palette. Spring injection fixes appear for supported contexts. | v0.87 설치 시험 · 실제 Spring 프로젝트의 설치판에서 12개 변경의 미리보기, 적용과 Undo 및 이름 바인딩 보존을 확인했다. 검토 후 바뀐 파일과 저장하지 않은 입력을 거부했다. [시험 기록](../test/java-cleanup-host.js) |
| IDEA-038 | 프로젝트 검사·스코프·심각도 프로필 · 구현 | Run Java Inspection Profile palette action, profile selection, Problems view, reusable settings under rocketbrain.java.inspectionProfiles. | v0.32 설치 시험 · 실제 Spring 작업 공간에서 세 개 검사 진단의 심각도, 인라인 제외, 외부 범위·미저장 파일 건너뛰기와 문서 수정 후 지우기를 확인했다. [시험 기록](../test/java-inspections-host.js) |
| IDEA-039 | 중복 코드 감지 · 구현 | Find Duplicate Java Code via palette, policy/match/occurrence selectors open source ranges. | v0.32 설치 시험 · 실제 Spring 소스에서 정확 일치 두 곳, 리터럴 무시 세 곳을 선택했다. 원본 범위, 취소, 편집 후 오래된 결과 탐색 거부를 확인했다. [시험 기록](../test/java-inspections.test.js) |
| IDEA-040 | 의존성 취약점·취약 API 사용 분석 · 구현 | Audit Maven Dependencies with OSV or Audit Gradle Dependencies with OSV in palette. Inspect Java Advisory Call Sites and Open Java Advisory Call Site in their report document schemes. | v0.111 설치 시험 · 두 빌드 도구의 실제 Spring 소스에서 권고 두 건의 호출 세 곳과 메서드 참조 한 곳을 찾았다. 권고에 연결된 수정 버전을 표시하고 파일이 바뀐 뒤 이전 참조 열기를 거부했다. [시험 기록](../test/java-advisory-calls-host.js) |
| IDEA-041 | Qodana·CI 품질 게이트 연결 · 구현 | Open Java Quality Gate Report via palette and select the SARIF. Gate execution is the bundled CLI/CI entry. CI runs start via the bundled CLI. | v0.46 설치 시험 · 두 실제 Spring 작업 공간에서 별도 Git 커밋과 기준선을 만들고 새 문제·기존 문제·회복된 문제 한 건씩, CLI 종료 코드 및 원본 커밋의 읽기 전용 위치를 검증했다. [시험 기록](../test/java-quality-gate-host.js) |

#### JVM 언어·프로젝트

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-042 | Java 버전·JDK·언어 수준 · 구현 | Java Projects item actions Review Java Runtime Compatibility, Change Saved Java Runtime and the editor action Inspect Java Source Build Target. Runtime configuration in settings, trust and project import needed. | v0.91 설치 시험 · 실제 8·17·21·25 JVM을 확인했다. 설치판에서 Java 8·21 모듈과 Spring Java 25 출력, 너무 낮은 버전 및 가짜 검토 거부, 저장한 인수와 환경을 유지한 Java 21 실행을 확인했다. [시험 기록](../test/java-runtime-matrix-host.js) |
| IDEA-043 | Java와 Kotlin 혼합 프로젝트 · 구현 | Build and Index Mixed JVM Sources, Go to Mixed JVM Declaration, Review Kotlin Symbol Rename and Inspect Java Nullability in Kotlin via palette. The editor uses a definition provider in supported mixed scope. | v0.113 설치 시험 · Kotlin 컴파일러가 위반한 제네릭 경계와 nullable 컬렉션 요소를 Problems에 표시했다. 정확한 Java 선언으로 이동하고 검사 뒤 변경된 소스의 이전 링크를 거부했다. [시험 기록](../test/kotlin-mixed-type-rename-host.js) |
| IDEA-044 | Kotlin JVM 코드 지원 · 구현 | Start Kotlin Language Support or Start Kotlin Maven Reactor via palette. Configured Kotlin distribution/JDK and build ownership gate native completion, definition and diagnostics. | v0.134 설치 시험 · 실제 Maven 3.9.11·Kotlin 2.2.21에서 Spring JDBC 제네릭 메서드와 형제 모듈 타입을 완성했다. 미저장 타입 오류를 확인·해제했고 두 DB에서 실제 앱 결과를 검증했다. 기존 Gradle 재검증도 통과했다. [시험 기록](../test/kotlin-maven-editor-host.js) |
| IDEA-045 | Kotlin Multiplatform·Compose 개발 · 구현 | Inspect Kotlin Multiplatform Targets, Compile/Test/Run Kotlin Multiplatform Target and platform Debug commands in palette. iOS Simulator launch guarded by trusted local macOS. Kotlin Coroutines is a separate tree. | v0.166 런타임 · 실제 Xcode·Kotlin/Native·iOS Simulator에서 Kotlin 프레임의 중단점과 지역 변수, 재개한 실행 결과를 확인했다. 대상·심볼·소스 검증과 테스트 시뮬레이터 정리도 확인했다. [시험 기록](../test/kmp-ios-debug.test.js) |
| IDEA-046 | Scala·sbt 개발 · 구현 | Start Scala Language Support, Import sbt Build for Scala Language Support, Compile and Index Scala, Run/Test/Debug sbt commands and native Scala editor providers after setup. | v0.136 설치 시험 · 실제 sbt와 Scala 2.13.18 및 3.9.0에서 형제 모듈 타입과 오버로드 편집을 확인했다. 정확한 테스트 소스에 중단했고 지역 변수를 읽은 뒤 선택한 스위트만 재개했다. Spring JDBC는 두 DB에서 확인했다. [시험 기록](../test/scala-language-host.js) |
| IDEA-047 | Groovy·Spock·콘솔 · 구현 | Groovy Console, Run Groovy Script, Run Selected Spock Specification, Debug Groovy Gradle Application and Complete Groovy Java Member / Open Groovy Java Member Declaration in palette with context. | v0.148 설치 시험 · 실제 Maven·Gradle과 두 DB에서 동적 지역 선언과 JDBC 결과를 확인했다. 설치본에서 Groovy 줄 중단점, 스텝, 지역 변수 및 완성 편집의 실행 취소·다시 실행을 검증했다. [시험 기록](../test/groovy-debug-host.js) |
| IDEA-048 | 외부 라이브러리 소스·바이트코드 디컴파일 · 구현 | Native Java definition target opens matching JDK/library source or the JDT read-only document. Manage Java Library Sources in palette for Java or JDT document. | v0.78 설치 시험 · 실제 컴파일한 JAR에서 분기 본문을 디컴파일하고 원본 파일을 연결한 뒤 해제했다. 오래된 검토를 거부하고 JDT 디버거가 대응 위치에서 멈춘 실제 JVM 출력을 확인했다. [시험 기록](../test/java-library-source-host.js) |
| IDEA-049 | Scratch·JShell 실험 코드 · 구현 | New JShell Scratch and Run JShell Scratch in palette. Choose source/output context and supported independent JDK. | v0.28 설치 시험 · 최종 v0.28.0 VSIX, 실제 Spring과 MySQL 8.4.13·MariaDB 11.4.8에서 JDK 25에서 격리 실행과 프로젝트 클래스 경로 실행을 구분했다. 미저장 스크래치로 새 Spring 클래스와 HTTP/JDBC를 호출하고 저장본을 다시 열었다. [시험 기록](../test/java-utilities.test.js) |
| IDEA-050 | 어노테이션 프로세서·Lombok 생성 코드 · 구현 | Configure rocketbrain.java.annotationProcessing.lombokJar and relevant build processor settings. Use native Java completion/definition after JDT restarts and imports the build. | v0.48 설치 시험 · 두 실제 Spring 작업 공간에서 Maven과 Gradle에 Lombok·MapStruct를 적용했다. 생성된 심볼의 완성·정의, 잘못된 getter 진단과 올바른 getter로 바꾼 뒤 다시 생성한 결과를 확인했다. [시험 기록](../test/java-annotation-processing-host.js) |

#### Spring·영속성

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-051 | Spring Initializr 프로젝트 생성 · 구현 | Create Spring Project in Java Projects title menu or palette. Choose Initializr metadata and inspect selected files before creating. | v0.75 설치 시험 · 두 DB에서 공식 Initializr의 Java Maven WAR, Kotlin Gradle JAR, Groovy Gradle JAR을 생성했다. 검토한 파일 바이트와 일회성 승인, 생성 단계의 자동 빌드 차단, 별도 실제 빌드·실행 및 각 앱의 JDBC 응답을 확인했다. [시험 기록](../test/spring-initializr-forms-host.js) |
| IDEA-052 | 기존 프로젝트 starter 편집 · 구현 | Edit Spring Starters in Java Projects title menu or palette. Select imported project/build and review supported file changes. | v0.108 설치 시험 · Maven에 실제 추가 BOM 두 개를 사용했다. 중복 관리 의존성을 보호하고 POM 변경과 미고정 모델을 거부했다. 새 Spring JAR로 실제 JDBC를 확인했다. [시험 기록](../test/spring-maven-imports-host.js) |
| IDEA-053 | Bean·Autowiring 분석·빠른 수정 · 구현 | Spring: Analyze Beans and Configuration, Spring: Navigate to Bean, supported Java autowiring code actions, Copy Spring Boot 4 Servlet Registration Trace Helpers / Inspect Spring Registration Trace and AOT actions via palette. Latest live scope needs helper wiring in target app. | v0.160 런타임 · 실제 Spring Boot 4.1.2 서블릿 앱에서 초기화 콜백, 가져오기 등록기, 순서가 지정된 후처리기, 나중에 일어난 등록 변경을 관찰했다. 빈 생성 횟수, 종료, 오류 전파와 두 DB의 HTTP·JDBC 결과를 비교했다. [시험 기록](../test/spring-boot-servlet-trace.test.js) |
| IDEA-054 | Bean의 논리 구조·의존성 그래프 · 구현 | Show Spring Bean Dependency Graph via palette. The graph and selectable source locations. Spring bean navigation reachable in Context Actions. | v0.42 설치 시험 · 실제 Spring 프로젝트의 의존 관계와 런타임 읽기, 명시적 순환과 모호한 후보, 소스 이동을 검증했다. [시험 기록](../test/spring-bean-graph-host.js) |
| IDEA-055 | Application Context·분석용 프로필 · 구현 | Prepare Local JVM Observer, Connect Local JVM Observer, Inspect Spring JPA Transaction Outcomes and Inspect Spring Persistence Contexts via palette. Prepared app/session required. | v0.125 설치 시험 · 실제 Spring 7.0.10과 두 DB에서 여섯 경계를 확인했다. REQUIRED는 하나, REQUIRES_NEW는 두 물리 트랜잭션이었다. 커밋·롤백과 중복 키 실패를 JDBC 행으로 대조했다. [시험 기록](../test/spring-jpa-transaction-host.js) |
| IDEA-056 | Boot properties·YAML 메타데이터 · 구현 | Native completion and definition in supported Spring application YAML/properties. Observed runtime source uses Spring runtime actions and connection. | v0.74 설치 시험 · Boot 4.1.2의 실제 플러그인이 만든 Integer 설정 메타데이터를 읽어 YAML에서 완성하고 정확한 Java 필드로 이동했다. 두 DB에서 프로필별 문서, 목록 교체, 맵·별칭, 여러 줄 값과 명령줄 우선순위를 실제 바인더 및 JDBC로 확인했다. [시험 기록](../test/spring-configuration-host.js) |
| IDEA-057 | Actuator 런타임 Bean·Health·Mappings · 구현 | Spring: Connect Local Runtime from Spring & JPA Analysis menu or palette. Open Spring Actuator Health from the runtime tree or palette and browse mappings/beans. | v0.42 설치 시험 · 두 Spring 앱에서 Health 상태, readiness·liveness, DB 구성 요소와 재조회·오래된 화면 정리를 확인했다. [시험 기록](../test/spring-actuator-health-host.js) |
| IDEA-058 | Spring 디버거의 실제 설정값·출처 · 구현 | Inspect Spring Property Value and Origin from palette. Inspect Spring Property in Active Debug Target on the Java debug toolbar and palette for active matching debug session. | v0.68 설치 시험 · 두 실제 Spring DB에서 환경 변수가 패키지 기본값을 덮어쓴 결과와 출처 두 곳을 확인했다. 설치판으로 동일 PID Java 연결, 가려진 값, 잘못된 PID 거부, 런타임 분리와 디버거 해제 시 화면 닫힘을 확인했다. [시험 기록](../test/spring-property-origin-host.js) |
| IDEA-059 | Spring Data 파생 메서드·쿼리 · 구현 | Native completion/definition for supported Spring Data repository methods with Java source/model readiness. Spring/JPA analysis and query types from analysis tree/palette. | v0.99 설치 시험 · 설치판에서 파생 메서드 여섯 개, 다른 파일 속성 이동 두 곳, Pageable 인자 분리와 미저장 변경을 검증했다. 실제 Spring Data PartTree 대조도 마쳤다. [시험 기록](../test/spring-derived-query-host.js) |
| IDEA-060 | JPQL/HQL 작성·JPA Console · 구현 | Open JPQL Console and Review and Run JPQL SELECT from palette. JPQL editor shortcut through the language mode. Observed Hibernate runtime required for execution. | v0.106 설치 시험 · 실제 Hibernate에서 루트·조인·NULL 행, 콜백 실행 없이 한 번의 읽기 전용 SELECT, 바뀐 매핑 거부를 확인했다. [시험 기록](../test/jpql-entity-projection-host.js) |
| IDEA-061 | DB 스키마→JPA 엔티티·매핑 생성 · 구현 | **Generate JPA Entity from Table** · **Review JPA Relationship Between Existing Entities** · DB 테이블과 Java 엔티티 매핑을 연결하는 명령이다. 활성 MySQL/MariaDB 연결, 프로젝트 엔티티, 적용 전 검토가 필요하다. | v0.40 설치 시험 · 실제 Spring 환경 두 곳에서 단일·복수 속성 재정의와 파생 식별자 매핑을 편집하고 Hibernate 양방향 조회, 소유 측 쓰기와 롤백을 확인했다. [시험 기록](../test/fixtures/jpa-entity-proof/DerivedIdentityRelationshipProof.java) |
| IDEA-062 | Persistence 트리·엔티티 관계도 · 구현 | **JPA: Show Entity Relationship Diagram** · Spring & JPA Analysis 트리의 JPA Relationships와 명령 팔레트에서 웹뷰를 연다. Hibernate 런타임 모델에는 별도 관찰 세션이 필요하다. | v0.69 설치 시험 · 각 실제 DB에서 기본 Hibernate 팩터리의 엔티티 21개와 관계 13개를 확인했다. 두 번째 팩터리와 중복 엔티티를 분리하고 실제 FK와 소스 위치, Canvas 렌더링 및 위치 복원, 연결 종료를 확인했다. [시험 기록](../test/jpa-relationship-diagram-host.js) |
| IDEA-063 | Hibernate 디버거·SQL 바인딩·N+1 · 구현 | **Prepare Local JVM Observer** · **Connect Local JVM Observer** · **Inspect Hibernate Fetch Activity** · 지원하는 Hibernate와 관찰기 JVM 재실행이 선행된다. Fetch Activity는 직접적인 관찰 경로이고 초기 분석 트리에 상시 그래프가 표시되는 구성은 아니다. | v0.116 설치 시험 · 두 DB에서 이름 있는 그래프는 각각 SELECT 한 번이었고 지연 로딩은 SELECT 네 번과 N+1 한 건이었다. 동적 이름 없는 그래프를 분리했고 메타데이터 확인 전후 SQL 카운터가 같았다. [시험 기록](../test/jpa-entity-graphs-host.js) |
| IDEA-064 | Spring Security 런타임 진단 · 구현 | **Inspect Spring Security Filter Trace** · **Inspect Spring Authentication Decisions** · **Prepare Local JVM Observer** · 필터·인증 관찰 명령이 있다. 지원하는 Spring Security 버전과 해당 추적 옵션을 켠 실행 JVM이 필요하다. | v0.134 설치 시험 · 실제 Spring Security 7.1.2의 두 DB에서 동시 요청, 두 단계 Servlet 위임, 네 가지 결과, 무시된 후보 없음과 보존한 지역 실패를 확인했다. WebFlux 인증 추적도 회귀 검증했다. [시험 기록](../test/spring-parent-authentication-host.js) |
| IDEA-065 | MVC·WebFlux·Feign 엔드포인트 탐색 · 구현 | **Spring: Navigate to Endpoint** · **Inspect OpenFeign Runtime Contracts** · 기본 라우트는 팔레트의 Spring: Navigate to Endpoint로 연다. docs/spring-feign-contracts.md의 Spring Endpoints 표기는 실제 제목과 다르다. 런타임 Feign 계약은 관찰기 설정이 필요하다. | v0.86 설치 시험 · 두 설치판에서 상속한 소스 범위 두 개, 프록시 두 개, 라우트 네 개를 실제 Spring 및 JDBC로 검증했다. 비활성 기본값과 사용자 정의 우선순위를 구분한다. [시험 기록](../test/spring-feign-contract-host.js) |

#### 기타 JVM 프레임워크

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-066 | Quarkus·MicroProfile · 구현 | **Create Quarkus Maven Project** · **Inspect Quarkus Configuration and Endpoints** · **Start Quarkus Dev Mode** · 기본 진입은 팔레트다. 별도 개발 JVM과 선택된 Maven/Gradle 도구가 필요하며 GraalVM 검증은 Linux 범위다. | v0.154 설치 시험 · 실제 Maven·Gradle Quarkus 개발 JVM에서 소스 중단점과 지역 변수를 읽었다. HTTP가 중단된 상태에서 디버거를 분리해 응답을 완료했고, 분리 중 소스를 다시 읽은 뒤 같은 JVM에 연결해 새 값을 확인했다. 두 DB와 Spring을 대조했고 별도 Linux Gradle ELF도 같은 JDBC 값을 반환했다. [시험 기록](../test/quarkus-attachable-dev-host.js) |
| IDEA-067 | Micronaut 개발 · 구현 | **Inspect Micronaut Application** · **Build and Run Micronaut** · **Debug Micronaut Application** · 기본 진입은 팔레트다. 가져온 Micronaut JVM 프로젝트가 필요하며 GraalVM 검증은 Linux Maven 범위다. | v0.152 런타임 · 별도 Linux에서 Micronaut GraalVM ELF를 실제 실행하고 두 DB의 Spring 비교 앱과 결과를 대조했다. 실제 JDT Buildship과 Gradle로 재시작 후보를 검증했으며 실패하거나 취소했을 때 기존 HTTP·JDBC JVM이 계속 동작했다. [시험 기록](../test/micronaut-gradle-restart-host.js) |
| IDEA-068 | Jakarta EE·애플리케이션 서버 배포 · 구현 | **Build Jakarta WAR** · **Manage Jakarta Deployments on Remote Tomcat** · **Review and Deploy Jakarta EAR on WildFly** · 팔레트에서 배포를 검토한다. 외부 Tomcat/WildFly, 역할·서버별 설정과 배포 아티팩트가 필요하다. | v0.148 설치 시험 · 실제 TLS Tomcat에서 두 DB별 배포와 세션 보존, 이전 WAR의 해시를 확인했다. 실제 WildFly에서 Maven EAR 가져오기와 WAR·EJB 모듈 호출을 설치본으로 검증했다. [시험 기록](../test/jakarta-manager-host.js) |

#### 빌드·실행

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-069 | Maven 프로젝트·목표·의존성 · 구현 | **Inspect Maven Dependency Resolution** · **Choose Build Task** · **Run Build Task** · Java Projects와 명령 팔레트에서 확인하며 별도 Maven 설치 및 정상 프로젝트 가져오기가 필요하다. | v0.138 설치 시험 · 실제 Maven에서 두 SNAPSHOT 버전을 내려받고, 내려받은 위치를 Maven 캐시와 대조했다. 외부 SNAPSHOT 부모와 BOM을 사용하는 리액터에서 설치형 Java Move, 변경된 캐시 메타데이터의 거부, 재검토 후 컴파일과 Spring JDBC를 두 DB에서 확인했다. [시험 기록](../test/maven-snapshot-host.js) |
| IDEA-070 | Gradle·Kotlin DSL·Task 탐색 · 구현 | **Choose Build Task** · **Run Build Task** · Choose Build Task는 프로젝트를 고른 뒤 목록을 트리에 채운다. README의 Discover Build Tasks라는 팔레트 제목은 없다. 실제 작업 선택은 Run Build Task 경로다. | v0.102 설치 시험 · 실제 Gradle에서 별칭이 있는 포함 빌드의 서비스 작업과 컴파일을 확인했다. 검토 후 Kotlin 빌드 스크립트가 바뀌면 거부했다. [시험 기록](../test/gradle-composite-tasks-host.js) |
| IDEA-071 | 모듈·혼합 빌드·프로젝트 인덱스 · 구현 | **Rebuild Java Workspace Index** · **Refresh Java Projects** · **Review Java Runtime Compatibility** · Java Projects 형태와 새 색인 명령이 있다. 유효 소스·클래스패스 및 Maven/Gradle 가져오기 상태에 의존한다. 초기 프로젝트 분석 준비 상태와 네이티브 클릭의 조합은 이 행의 기존 근거에서 재검증되지 않았다. | v0.156 런타임 · 실제 Maven·Gradle 작업공간을 별도 JDT JVM에서 읽었다. 새 색인과 보존한 이전 캐시를 구별했고 생성된 Java 선언으로 같은 경로를 탐색했다. 전환과 재시작 중 두 DB의 Spring JDBC 결과를 확인했다. [시험 기록](../test/java-workspace-index.test.js) |
| IDEA-072 | 증분 빌드·빌드 도구 위임 · 구현 | **Build Java Project** · **Review Delegated Java Compile** · **Review Failed Java Compile Retry** · Java Projects 또는 팔레트에서 시작한다. 선택한 Maven/Gradle 실행과 소스/빌드 저장 상태가 필요하다. | v0.102 설치 시험 · 실제 Spring 프로젝트에서 출력 재사용, 미저장 또는 오래된 검토 거부, 컴파일 실패와 clean 없이 고친 뒤 재시도를 확인했다. [시험 기록](../test/java-delegated-build-host.js) |
| IDEA-073 | 실행 구성·환경·사전 작업·공유 · 구현 | **Add Java Run Configuration** · **Configure Spring Boot Run** · **Export Shared Java Run** · Java Projects와 팔레트로 구성한다. 검토한 기본 구성과 JDK가 필요하다. 공유 구성의 로컬 경로와 민감 값은 가져올 때 다시 채운다. | v0.80 설치 시험 · 설치판에서 민감한 로컬 값이 없는 공유 명세를 검토하고 다른 값을 넣었다. 가져오기만으로 실행되지 않음을 확인했고, 실제 DB를 쓰는 두 Spring 실행을 시작하고 각각 중지했다. [시험 기록](../test/java-shared-runs-host.js) |
| IDEA-074 | 복수 서비스·Compound·실행 순서 · VS Code 재사용 | Run and Debug → launch.json compounds · VS Code Run and Debug에서 launch.json compounds를 사용한다. 별도 Rocketbrain 그룹 명령은 IDEA-073 범위다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |

#### 디버깅

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-075 | JVM 시작·프로세스/원격 연결 · 구현 | **Debug Java Main Class** · **Attach to Local Java Process** · **Debug Java Configuration** · VS Code Run and Debug와 Rocketbrain Java 디버그 종류가 연결된다. 독립 Java 디버그 런타임과 실행 또는 명시적 JDWP 연결이 필요하다. | v0.148 설치 시험 · Windows의 일반 명령줄 한도를 넘는 실제 Spring 클래스패스를 인수 파일로 넘겼다. 설치본에서 가상 스레드의 줄 중단점과 실행 재개가 동작하고 JDBC 42 응답을 두 DB에서 확인했다. [시험 기록](../test/java-async-trace-host.js) |
| IDEA-076 | 조건·적중 횟수·로그 중단점 · 구현 | Editor gutter / Run and Debug → Breakpoints · 조건·히트 횟수·로그는 VS Code 편집기 여백과 Run and Debug Breakpoints의 Edit Breakpoint를 통해 Rocketbrain 디버거에 전달한다. | 소스 및 한정 실행 · 일반 Java 실제 JVM의 중단점·예외·watch/값 수정·step·수동 HCR과 실제 Spring/JPA attach 표본. 다른 언어·모든 JVM 조합은 제외한다. [시험 기록](../test/java-debug-advanced-host.js) |
| IDEA-077 | 메서드·필드·행 내부 중단점 · 구현 | Run and Debug → Variables → Break on · **Add Java Method Breakpoint** · **Add Java Inline Breakpoints** · 메서드와 인라인은 팔레트와 디버그 상태에서 제공된다. 필드 읽기·쓰기는 정지된 VS Code Variables의 Break on 메뉴가 네이티브 경로다. 행의 기존 설치 검증은 dataBreakpointInfo/setDataBreakpoints 직접 호출을 사용했다. | v0.45 설치 시험 · 실제 Spring 프로젝트에서 String 오버로드와 상속 선언, 필드 읽기와 쓰기, 같은 줄의 두 람다에 각각 정지했다. Object 오버로드도 중단 없이 실행했으며 JVM 결과는 44였다. [시험 기록](../test/java-debug-breakpoints-host.js) |
| IDEA-078 | 예외 종류·Caught/Uncaught 필터 · 구현 | **Configure Java Exception Breakpoints** · 팔레트에서 유형과 발생 클래스 패턴을 입력하고 Run and Debug 예외 필터를 사용한다. 여러 타입에는 지정된 디버그 번들이 필요하다. | v0.58 설치 시험 · Spring 프로젝트를 가져온 설치 디버거에서 JVM의 caught·uncaught 예외, 서로 겹치는 타입의 중복 중단 방지, 다른 예외와 라이브러리 발생 위치 제외, 실행 중 정책 갱신을 확인했다. [시험 기록](../test/java-debug-exceptions-host.js) |
| IDEA-079 | Smart Step·라이브러리 필터·비동기 스택 · 구현 | **Step Into a Java Call** · 일시 정지한 Rocketbrain Java 디버그 세션이 필요하다. 비동기 제출 추적은 지원한 런타임과 관찰 설정을 직접 준비해야 한다. | v0.156 런타임 · 실제 JDT 실행과 별도로 소유한 프로세스 연결에서 세 단계의 소스 위치와 등록·실행 스레드를 두 DB 모두 확인했다. Spring JDBC 42와 실패·취소·실행기 거부의 표준 동작이 유지됐다. 기존 Executor·가상 스레드·Reactor도 재검증했다. [시험 기록](../test/java-async-trace.test.js) |
| IDEA-080 | 표현식 평가·Watch·변수 수정·프레임 · 구현 | Run and Debug → Variables / Watch / Call Stack · **Inspect Java Local Value** · **Restart Java Stack Frame** · 정지된 Run and Debug의 Variables·Watch·Call Stack과 팔레트 명령을 사용한다. 더 긴 값과 프레임 기능은 지원 JVM과 값 형식에 의존한다. | v0.156 설치 시험 · 두 실제 DB에서 Java 실행과 Kotlin 프로세스 연결을 각각 확인했다. Latin-1과 넓은 문자열을 34페이지씩 읽어 272,016과 273,199 코드 단위를 복원했다. 이모지 경계와 단독 서로게이트, 재개 후 읽기 거부, 기존 짧은 조회와 프레임 동작을 검증했다. [시험 기록](../test/jvm-long-string-pages.test.js) |
| IDEA-081 | HotSwap·변경 클래스 재적용 · 구현 | **Apply Hot Code Replace** · 팔레트에 기본 표시되지만 실행은 일시 정지한 Rocketbrain Java 디버그 세션 및 저장된 소스를 요구한다. Java 구조 변경은 상이한 JVM 동작을 갖는다. | 소스 및 한정 실행 · 일반 Java 실제 JVM의 중단점·예외·watch/값 수정·step·수동 HCR과 실제 Spring/JPA attach 표본. 다른 언어·모든 JVM 조합은 제외한다. [시험 기록](../test/java-debug-advanced-host.js) |
| IDEA-082 | Java Stream 값 변환 시각화 · 구현 | **Trace Java Stream Values** · Java 편집기에서 지원 스트림 식을 선택해야 활성화된다. 지원 스트림의 실측·시각 검토 화면은 편집기에서 시작하는 명령이다. | v0.83 설치 시험 · 설치판에서 anyMatch가 네 번째 입력에서 끝나는 사례와 정렬 입력 다섯 건을 확인했다. 순회하지 않은 count 및 Spring Java 원본 선택으로 이동하는 흐름도 검증했다. [시험 기록](../test/java-stream-trace-host.js) |
| IDEA-083 | Kotlin 코루틴 상태·생성 스택 · 구현 | **Prepare Kotlin Coroutine Debug Attach** · **Connect Local Kotlin Coroutine Probe** · **Debug a Parked Kotlin Coroutine** · Kotlin Coroutines 트리와 팔레트를 사용한다. 지원 로컬 JVM에 관찰기와 디버그 연결 준비가 필요하다. | v0.104 설치 시험 · 동일한 이름과 클래스의 다른 코루틴과 구분했다. 디버거 정지 중 JDBC 조회와 분리 뒤 계속 실행을 확인했다. [시험 기록](../test/kotlin-coroutine-debug-host.js) |

#### 테스트·프로파일링

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-084 | JUnit·TestNG 발견·실행·디버그 · 구현 | Testing activity view · **Install Independent Java Test and Coverage Runtime** · **Discover Java Tests** · **Run Java Tests** · Java Projects의 Discover Java Tests는 IntelliJ 모드의 더 보기 메뉴에 있다. 실제 테스트 트리는 기본 Testing 뷰이며 테스트·커버리지 런타임 설치가 따로 필요하다. | v0.108 설치 시험 · 실제 명명 모듈에서 두 엔진의 선택 실행을 확인했다. TestNG의 동일 인자 행을 구분하고 JaCoCo 결과 및 별도 실제 JDI 중단·재개를 대조했다. [시험 기록](../test/java-testing-named-testng-host.js) |
| IDEA-085 | 테스트 결과·실패 diff·재실행 · 구현 | Testing activity view · **Open Java Test Run History** · **Rerun Failed Java Tests** · Testing과 팔레트를 사용한다. 실패 diff와 재실행은 보존된 실행과 현재 재탐색한 호출이 있어야 나타난다. | v0.80 설치 시험 · 설치판에서 Jupiter 및 TestNG의 실행 기록과 실패 diff를 열었다. 고유한 TestNG 데이터 공급자 호출 한 건을 다시 선택해 성공을 확인했다. [시험 기록](../test/java-test-history-host.js) |
| IDEA-086 | 코드 커버리지·분기·테스트별 커버 · 구현 | Testing activity view · **Run Java Tests with Coverage** · **Run Java Tests with Coverage by Test (Serial)** · Testing의 커버리지와 팔레트로 시작한다. 지원 런타임과 해당 클래스·소스의 정확한 대응 및 테스트별 순차 실행을 요구한다. | v0.84 설치 시험 · 두 DB의 Spring 워크스페이스에서 JUnit·TestNG가 반대 가지를 각각 실행한 경우를 확인했다. 전체 집계, 네이티브 원본 위치, 복합 조건의 줄 집계 유지도 검증했다. [시험 기록](../test/java-branch-coverage-host.js) |
| IDEA-087 | CPU·할당·JFR 프로파일 · 구현 | **Record JVM Profile** · **Inspect JVM Flight Recording** · 팔레트에서 JFR 프로세스와 녹화 길이를 고른다. 플레임 그래프, 시간축과 녹화 비교는 기능표에 별도 남은 범위로 기록된다. | v0.31 설치 시험 · 실제 Spring JVM의 JDBC 부하를 유지하며 CPU·할당 표본과 JFR 저장·재열기를 확인했다. [시험 기록](../test/jvm-diagnostics-host.js) |
| IDEA-088 | 힙 덤프·메모리 누수 분석 · 구현 | **Inspect JVM Heap Dump** · **Inspect JVM Heap Histogram** · 팔레트에서 소유 로컬 JVM 또는 HotSpot HPROF를 고른다. 다른 덤프 형식의 대체 경로는 이 행 근거에 포함되지 않는다. | v0.79 설치 시험 · 설치판에서 실제 Temurin 힙 덤프를 읽었다. 상속 필드와 순환을 확인하고 공유 객체와 약한 참조를 분리해 예제의 유지 객체 6개와 기록 데이터 58,056바이트를 확인했다. [시험 기록](../test/java-hprof-host.js) |
| IDEA-089 | 스레드·가상 스레드·덤프 분석 · 구현 | **Capture JVM Threads** · **Inspect JVM Thread Snapshot** · 팔레트에서 캡처·저장 스냅샷을 연다. 스레드 시간축과 캡처 비교는 기능표에 별도 남은 범위로 기록된다. | v0.31 설치 시험 · 실제 Spring JVM의 플랫폼 스택을 저장·재열기했다. 별도 소유 JDK 프로세스에서 가상 스레드·잠금·교착 상태 파싱을 검증했다. [시험 기록](../test/jvm-diagnostics.test.js) |

#### VCS·리뷰

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-090 | Git 변경·부분 stage·blame·기록 · VS Code 재사용 | Source Control → Changes / Staged Changes, Explorer → Timeline · VS Code Source Control과 Git 설치에 의존한다. 원본 Git 고급 도구의 UX 증거는 별도다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-091 | Changelist·작업 컨텍스트 · 구현 | **Manage Git Changelists** · 팔레트에서 로컬 Git 변경목록 화면을 연다. 작업 위치와 선택한 실행 구성 이름을 목록에 저장할 수 있다. | v0.43 설치 시험 · 두 Spring 작업 공간에 만든 별도 Git 저장소에서 같은 이름의 파일 구분, 목록 이동, 편집 위치와 실행 구성 선택 복원을 확인했다. 누락 파일과 변경된 선택 위치를 알렸고 Git 인덱스와 HEAD를 보존했다. [시험 기록](../test/changelists-host.js) |
| IDEA-092 | Shelf·Stash·선택 변경 보관 · 구현 | Source Control → Stash · **Manage Git Shelf** · 팔레트에서 검토할 미스테이징 변경과 적용 대상을 선택한다. VS Code Stash는 별도 호스트 경로다. | v0.95 설치 시험 · 실제 Git 워크트리에서 두 변경 조각을 옮겼다. 양쪽 인덱스와 미선택 변경을 보존하고 충돌 후 보관본 유지와 재적용을 확인했다. [시험 기록](../test/git-shelf-host.js) |
| IDEA-093 | Branch·Rebase·Merge 충돌 해결 · VS Code 재사용 | Source Control → Branch / Merge / Rebase · VS Code Source Control에서 브랜치와 병합 편집기를 사용한다. Git 저장소와 해당 작업 상태가 필요하다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-094 | Git Worktree·작업별 프로젝트 설정 · 구현 | **Manage Git Worktree Context** · 신뢰한 열린 Git 워크트리에서 명령 팔레트로 문맥을 설정한다. | v0.81 설치 시험 · 설치판에서 두 실제 Git Worktree와 각각의 Java 프로젝트를 해석했다. Spring Actuator 응답을 읽고 각 DB 프로필로 두 SQL 세션을 열었다. 기존 활성 연결을 보존하고 변경된 문맥과 프로필을 거부했다. [시험 기록](../test/git-worktree-context-host.js) |
| IDEA-095 | GitHub PR·GitLab MR 리뷰 · 구현 | **Open GitHub or GitLab Review** · **Set Repository Review Token** · 팔레트에서 GitHub/GitLab 리뷰 화면을 연다. 저장소 위치, 서비스 접근 권한 및 승인받은 실제 송신이 별도다. | v0.106 설치 시험 · 소유 HTTP 시험 서버에서 정확한 커밋과 노트 승인, 수정된 원본과 불확정 응답의 재전송 거부를 확인했다. [시험 기록](../test/code-review-actions-host.js) |

#### 원격·컨테이너

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-096 | SSH 원격 개발 · 구현 | **Open SSH Workspace** · **Open Reviewed SSH Workspace Terminal** · **Start Reviewed SSH Java Analysis** · SSH Workspace 트리와 팔레트에서 시작한다. 서버·계정·키, 승인된 원격 작업과 Linux 런타임이 필요하다. | v0.142 설치 시험 · 두 환경의 설치된 VS Code에서 SSH 원격 문서 두 개가 외부 변경에 따라 갱신됐다. 검토 전 변경 거부, 부분 전송, 접속 중단 후 재접속 바이트 대조와 JDBC 보존을 확인했다. [시험 기록](../test/ssh-watch-host.js) |
| IDEA-097 | WSL 실행·개발 · 구현 | **Open WSL Project Folder** · **Review and Run WSL Workspace Build** · **Watch Open WSL Source** · Windows 신뢰 작업공간에서 팔레트로 시작한다. WSL 배포판·소스 경로 및 필요한 Linux 도구에 의존한다. | v0.152 런타임 · 별도 실제 WSL 2 설치본에서 변경 감지·읽기 전용 차이·저장하지 않은 편집 보존·다른 편집기 포커스 유지와 선택 재로드를 확인했다. 줄 중단점과 스텝으로 실제 Spring JVM을 제어했고 MySQL·MariaDB의 Linux JDBC와 Windows 쿼리가 각각 42로 일치했다. [시험 기록](../test/wsl-source-watch-host.js) |
| IDEA-098 | Dev Container 환경 · 구현 | **Inspect Dev Container Configuration** · **Start Managed Dev Container** · **Start Managed Container Java** · 팔레트에서 실제 Docker 컨테이너와 Java 연결을 따로 시작한다. 컨테이너 안의 엔진과 대상 JVM이 준비돼야 한다. | v0.116 설치 시험 · 실제 Ubuntu Docker에서 Java 진단·hover·정의·포맷을 확인했다. 별도 JVM을 연결해 소스 중단점과 변수를 확인하고 해제한 JVM 포트만 닫았다. [시험 기록](../test/devcontainer-java-host.js) |
| IDEA-099 | Docker·Compose·Registry 관리 · 구현 | **Select Docker Context** · **Inspect Compose Project** · **Open Compose Override Draft** · Docker 트리 또는 팔레트에서 Docker 설치와 데몬 컨텍스트를 선택한다. | v0.132 설치 시험 · 실제 Docker Engine 28.0.4와 Distribution 3.0.0에서 TLS 읽기·푸시 권한과 읽기 전용 거부를 확인했다. 실제 Compose 2.38.2에서 세 파일의 적용 순서와 저장 후 모델을 대조했다. Windows 설치본에서 명령 및 미승인 요청 거부를 확인했다. [시험 기록](../test/docker-registry-permissions.test.js) |
| IDEA-100 | Kubernetes·Helm·클러스터 탐색 · 구현 | **Choose Kubernetes Context** · **Open Kubernetes Pod Logs** · **Review Helm Rollback** · 기본 접힌 Kubernetes 뷰를 열거나 팔레트를 사용한다. kubeconfig, 대상 클러스터, 설정된 kubectl/Helm 경로 및 역할이 필요하다. | v0.125 설치 시험 · 실제 Kubernetes에서 복제본 1→0→1, 버전이 변한 승인 거부, Helm 리비전 2에서 1의 내용을 새 리비전 3으로 복원하는 것을 검증했다. kubectl과 Helm이 각각 동일한 승인 실행 파일의 자격 증명으로 접속했다. [워크플로](../.github/workflows/kubernetes-explorer.yml) |

#### 웹·API·데이터 도구

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-101 | 내장 터미널·셸·세션 · VS Code 재사용 | Terminal → New Terminal · VS Code 통합 터미널의 기본 기능을 사용한다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-102 | HTTP 요청·환경·인증·검증 스크립트 · 구현 | **Send HTTP Request** · **Run HTTP Workflow** · **Select HTTP Environment** · .http 문서가 활성일 때 편집기와 팔레트의 명령을 사용한다. 실행 대상과 환경을 검토한다. | v0.102 설치 시험 · 실제 Spring JDBC 값을 두 번째 요청에 전달했다. 검토가 바뀌거나 필요한 값이 빠지면 이후 요청을 멈췄다. [시험 기록](../test/http-workflow-host.js) |
| IDEA-103 | OpenAPI·Swagger 편집·미리보기·코드 생성 · 구현 | **Inspect OpenAPI Description** · **Create HTTP Request from OpenAPI** · **Create Java Client from OpenAPI** · JSON/YAML 편집기에서만 이용하는 명령이다. 지원 OpenAPI 문서의 진단·선택 작업과 생성 미리보기를 제공한다. | v0.92 설치 시험 · Swagger 2에서 생성한 정확한 Spring 컨트롤러를 실제 Spring MVC에서 컴파일·실행했다. 기본 경로, 요청 필수 헤더의 400 응답과 JSON 입력, 실제 JDBC 조회를 검증했다. [시험 기록](../test/swagger-spring-server-host.js) |
| IDEA-104 | GraphQL·gRPC·WebSocket 클라이언트 · 구현 | **Send HTTP Request** · **Inspect GraphQL Endpoint Schema** · **View WebSocket Transcript** · .http 문서와 서비스별 입력 계약이 필요하다. 여러 proto, 서버 리플렉션과 GraphQL 구독은 기능표의 남은 범위다. | v0.47 설치 시험 · 두 설치형 환경에서 인증된 루프백 gRPC 서버에 네 가지 호출을 보내고 정밀한 int64와 작업 공간 밖 정의 거부를 확인했다. GraphQL·WebSocket 이전 검증도 유지한다. [시험 기록](../test/grpc-client-host.js) |
| IDEA-105 | IDE 안의 DB 연결·SQL·데이터 편집 · 구현 | **Add Database Connection** · **Open Dedicated Profile SQL Console** · **Bind SQL File to Database Profile** · DataGrip 모드 Database Connections와 SQL 편집기·Query Results를 사용한다. 활성 DB 계정과 지원 편집 키·권한 조합이 필요하다. | v0.108 설치 시험 · 저장 파일 두 개에서 두 실제 DB의 동시 실행·결과 이동·롤백을 확인했다. 세션을 끊었을 때 다른 DB로 전환하지 않았고 명시적으로 다시 연결했다. [시험 기록](../test/sql-file-profiles-host.js) |
| IDEA-106 | JavaScript·TypeScript·Node/브라우저 디버그 · VS Code 재사용 | Run and Debug → bundled JavaScript Debugger · 호스트 JS/TS 편집기·JS 디버거에서 실행한다. Node 또는 브라우저 실행 환경을 갖춘 구성에 의존한다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-107 | React·Angular·Vue 프레임워크 · 구현 | **Check Vue Project** · **Check React Props** · **Start Angular Template Analysis** · 관련 프로젝트에서 소스 언어별 팔레트 명령과 편집기 기능을 사용한다. 프레임워크 모듈과 지원 Node/TypeScript 설정에 의존한다. | v0.140 설치 시험 · 실제 React 렌더와 TypeScript 5.9.3의 미저장 TSX 오류, 공식 Angular 22.3 언어 서비스와 TypeScript 6의 컨트롤 흐름·별칭·이벤트 탐색 및 저장한 오류 수정의 진단 해제를 두 DB에서 확인했다. [시험 기록](../test/react-props-host.js) |
| IDEA-108 | HTML·CSS/SCSS·Emmet·Preview · VS Code 재사용 | Language mode / Emmet commands · HTML/CSS 및 Emmet이 있는 VS Code 편집기에서 작업한다. IDE 범용 미리보기 UI는 기존 지원 범위에서 별도로 적혀 있다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-109 | Python 언어·환경·디버그 · 구현 | **Select Python Interpreter** · **Run Python File** · **Debug Python File** · Python 문서에서 로컬 인터프리터·debugpy와 독립 Pyright 실행을 설정한다. | v0.128 설치 시험 · 실제 Pyright 1.1.414와 설치형 편집기에서 타입 오류가 수정 후 사라졌다. 타입 힌트와 완성, 두 파일 이름 변경, 실제 정의 위치를 확인했다. [시험 기록](../test/python-types-host.js) |
| IDEA-110 | Jupyter Notebook·커널·셀 디버그 · 구현 | **New Python Notebook** · **Reset Notebook Python Kernel** · **Debug Python Notebook Cell** · Rocketbrain Python 노트북 편집기·셀 UI와 팔레트를 사용한다. ipykernel이 설치된 Python 경로를 확인해야 한다. | v0.125 설치 시험 · 실제 설치형 노트북에서 2행 중단점과 3행 이동, 35와 70의 지역 변수, 저장한 출력을 확인했다. 편집한 셀과 이미 재개한 중단 상태는 거부했다. [시험 기록](../test/jupyter-debug-host.js) |

#### 설정·확장·AI

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-111 | 원격 파일 배포·SFTP/FTPS/WebDAV · 구현 | **Review SFTP Project Deployment** · **Review FTPS Project Deployment** · **Review WebDAV Deployment** · 팔레트에서 프로필·파일을 선택해 변경과 전송을 검토한다. 서버별 권한과 파일 송신 단계가 필요하다. | v0.108 설치 시험 · 실제 세 서버에서 두쪽 변경과 충돌을 대조했다. FTPS의 암호화 데이터 연결과 새 이름을 확인했고, 검토한 파일만 게시했다. [시험 기록](../test/sftp-deployment-host.js) |
| IDEA-112 | 설정·스타일·프로필 동기화 · VS Code 재사용 | Manage → Profiles / Settings Sync · VS Code Profiles 및 Settings Sync를 사용한다. JDK·DB 자격 증명 전송은 기능표에서 별도 범위다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-113 | IDE 키맵·동작 컨텍스트·테마 · 구현 | Preferences: Color Theme → Rocketbrain Dark · **Keyboard Profile** · 작업공간에서 선택하는 52개 키보드 규칙과 별도 Rocketbrain Dark 테마가 있다. 모드 선택이 키맵·기본 마우스 동작을 자동 전환하지 않는다. 기존 키입력 근거는 Ctrl+클릭과 실제 Java 분석의 결합을 재현하지 않는다. | v0.160 런타임 · OS별 단축키 규칙 52개를 검증했다. Linux의 실제 VS Code에서 SQL 포맷과 Java 정의 이동 키 입력, Quick Pick 포커스, Escape, 작업공간 격리와 재시작을 확인했다. [시험 기록](../test/keyboard-profile.test.js) |
| IDEA-114 | 플러그인 설치·호환·갱신 · VS Code 재사용 | Extensions → Install from VSIX · VS Code Extensions에서 VSIX를 설치·갱신한다. JetBrains 확장 포맷 실행은 범위 밖이다. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |
| IDEA-115 | AI 완성·채팅·프로젝트 문맥 · 구현 | **Ask Local Code Model** · **Allow Local Inline Completions for This File** · **Start Local Workspace Conversation** · 편집기와 팔레트에서 자체 로컬 모델을 선택한다. 공급자 주소·모델과 문맥 승인, 파일별 인라인 활성화가 필요하다. | v0.111 설치 시험 · 실제 Qwen이 Java 커서에 제안하고 두 Spring 소스의 문맥에 답했다. 설정하거나 선택하지 않은 파일은 보내지 않았고 현재 창에서 이전 승인 대화를 이어갔다. [시험 기록](../test/editor-inline-model-host.js) |
| IDEA-116 | Air·ACP 에이전트·병렬 작업 · 구현 | **Review Local ACP Agent Replies** · **Review an ACP Multi-File Edit** · **Start or Continue a Saved ACP Session** · 별도 ACP 에이전트 선택과 검토가 필요하다. 초기 IntelliJ/DataGrip 모드 화면 어디에도 기본 세션이 자동 연결되지는 않는다. | v0.106 설치 시험 · 실제 OpenCode와 Qwen이 두 Java 파일의 변경을 제안했다. 컴파일 후 Spring에서 실행했고 새 OpenCode 프로세스가 암호화한 이력을 복구했다. [시험 기록](../test/acp-workspace-edit-host.js) |
| IDEA-117 | IDE 기능을 MCP 도구로 제공 · 구현 | MCP client / .vscode/mcp.json · VSIX에 dist/ide-mcp-server.js가 포함된다. 기본 UI 진입 버튼 없이 같은 계정의 MCP 클라이언트에서 README의 수동 설정을 따라야 한다. | v0.50 설치 시험 · 패키지의 stdio 실행 파일을 공식 MCP 클라이언트와 두 프로토콜 버전에서 사용했다. 실제 Spring 인벤토리, 소스 검사, SQL 구조, 도구 권한 및 취소를 확인했다. [시험 기록](../test/ide-mcp-host.js) |
| IDEA-118 | 프로젝트 신뢰·제한 모드 · 구현 | Workspaces: Manage Workspace Trust · VS Code Manage Workspace Trust를 사용한다. 설치 직후 모드 선택과 Java·디버깅·실제 DB·관찰 기능의 신뢰 조건은 서로 다른 단계다. | 소스와 신뢰 경계 시험 · 기존 실제/단위 검사에서 untrusted 시작/attach·관찰 거부와 await 중 trust 철회/stale 응답 폐기를 확인했다. 신규 native wrapper 단위11/11에서 테스트 발견 중 철회·각 다음 project engine 호출 직전 trust 재검사와 SQL metadata await 이후 재검사를 확인했다. [시험 기록](../test/java-debug.test.js) |

#### 작업 공간·편집기

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-119 | 문자열 안 SQL/정규식/HTML 언어 주입 · 구현 | **Edit Embedded Language** · **Review and Apply Embedded Source Edit** · **Reveal Embedded Java Source** · 지원 Java 리터럴·텍스트 블록에서 문맥 메뉴 또는 팔레트로 시작한다. 편집 조각에서 원본 적용은 별도 명령이며 변경 검토가 필요하다. | v0.88 설치 시험 · 두 설치판에서 regex 진단 위치, HTML 완성과 양쪽 태그 이름 변경, 소스 미리보기·Undo, text block 공백 보존 및 실제 JDBC 출력의 HTML을 확인했다. [시험 기록](../test/java-embedded-language-host.js) |

#### 기타 JVM 프레임워크

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| IDEA-120 | JavaFX·FXML·Scene Builder·패키징 · 구현 | **Preview JavaFX FXML** · **Refresh JavaFX FXML Preview** · **Run or Package JavaFX Application** · FXML 문서에서 OpenJFX 자체 미리보기와 정적 장면 속성 제한 편집을 연다. 행 제목의 Scene Builder는 외부 편집기 전체 기능과 같은 범위로 해석할 수 없으며 현재 지원 화면은 Rocketbrain 패널이다. | v0.140 설치 시험 · 실제 OpenJFX에서 노드 순서 변경, 팔레트 삽입과 안전한 잎 노드 제거 후 저장한 FXML이 제안한 픽셀과 일치했다. 두 DB 환경에서 검토 재사용 거부와 읽기 결과를 확인했다. [시험 기록](../test/javafx-hierarchy-host.js) |

### DataGrip

#### 연결·드라이버

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-001 | MySQL 데이터 소스 생성·연결 검사 · 구현 | Database Connections + opens the connection form. Test, Save and Save & Connect dispatch through the installed extension. · **Add Database Connection** · **Test Database Connection** · **Connect Database Profile** | v0.94 설치 시험 · MySQL 8.4.13과 9.7.4에서 실제 정상·오류 연결, utf8mb4, +05:30 TIMESTAMP의 6자리 소수초, DECIMAL·unsigned BIGINT를 검증했다. MySQL 9의 VECTOR 통신과 텍스트·바인딩 조회에서 SQL NULL 보존도 확인했다. [시험 기록](../test/mysql-native-vector-host.js) |
| DG-002 | MariaDB 전용 지원 · 구현 | The connection wizard is shared by MySQL and MariaDB. Sequence details and reviewed package calls are separate catalog actions. · **Add Database Connection** · **Inspect MariaDB Sequence** · **Review MariaDB Package Call** | v0.97 설치 시험 · 설치판에서 10.11, 11.4, 12.3의 양·음 증가와 캐시 상태를 확인했다. 12.3에서는 UNSIGNED 고정밀 메타데이터를 확인했고 MySQL은 엔진 전용 경로를 차단했다. [시험 기록](../test/mariadb-sequence-details-host.js) |
| DG-003 | 다중 SQL·NoSQL DBMS 드라이버 · 구현 | The secondary engines each have explicit open and run commands. The main Database tree and shared schema authoring are MySQL/MariaDB. · **Connect MySQL / MariaDB** · **Open Local SQLite Snapshot** · **New SQLite Query** | v0.106 설치 시험 · 실제 SQLite에서 64비트 한계, 실수, 유니코드, BLOB과 NULL을 원본에 반영했다. 다른 행, 잠금 및 파일·스키마·행 변경에 대한 검토를 확인했다. [시험 기록](../test/sqlite-cell-edit-host.js) |
| DG-004 | 사용자 JDBC JAR·드라이버 클래스 추가 · 구현 | JDBC Add Driver prompts for approved isolated driver/JAR settings and can then browse its connected catalog. · **Add JDBC Driver** · **Manage JDBC Profiles** · **Browse JDBC Tables and Views** | v0.47 설치 시험 · Oracle Connector/J 9.7.0과 MariaDB Connector/J 3.5.10을 실제 서버에서 사용했다. 정밀 데이터, 읽기 취소와 변경된 JAR 및 쓰기 거부를 각각 확인했다. [시험 기록](../test/jdbc-host.js) |
| DG-005 | 드라이버 버전 교체·추가 라이브러리 · 구현 | Manage JDBC Profiles opens a picker for add, test, connect, review a new driver version and rollback for the selected profile. · **Manage JDBC Profiles** | v0.48 설치 시험 · 두 실제 DB에서 Connector/J 3.5.7과 3.5.10으로 동일 DB에 연결해 버전 전환과 복귀를 확인했다. 변경된 JAR, 중복 클래스, 암묵적으로 참조한 라이브러리와 전환 후의 이전 인증 세션을 거부했다. [시험 기록](../test/jdbc-versions-host.js) |
| DG-006 | 사용자·비밀번호·무인증 모드 · 구현 | In the profile editor choose Authentication > Password or No password; Test uses the selected credentials. · **Add Database Connection** · **Edit Database Connection** · **Test Database Connection** | v0.91 설치 시험 · MySQL caching_sha2_password와 MariaDB mysql_native_password, 실제 무암호 계정, 대체 익명 계정·잘못된 암호 거부, 내보내기 후 재연결과 네이티브 프로필 폼을 검증했다. [시험 기록](../test/database-password-free-host.js) |
| DG-007 | 비밀정보 저장·저장하지 않기 · 구현 | The same profile form offers Remember password, or OpenBao KV v2 with a separate scoped token prompt. · **Add Database Connection** · **Edit Database Connection** · **Connect Database Profile** | v0.102 설치 시험 · OpenBao 2.7.3에서 일회 권한, 실제 DB 암호 회전, 승인 취소와 잘못된 CA 거부, 내보낸 프로필과 저장소에 민감값이 없는 것을 확인했다. [시험 기록](../test/openbao-profile-host.js) |
| DG-008 | TLS CA·호스트 검증 · 구현 | Verified TLS and certificate DNS name in the profile form; explicit review and reconnect for trust change. · **Add Database Connection** · **Edit Database Connection** · **Review Database TLS Trust and Reconnect** | v0.92 설치 시험 · 실제 만료 인증서, 틀린 호스트와 CA를 거부했다. 동일 경로 CA 교체를 검토한 후 바뀐 신뢰 파일·다른 정상 피어·승인 재사용을 거부하고 승인한 피어에 재연결했다. [시험 기록](../test/server-tls-trust-host.js) |
| DG-009 | 클라이언트 인증서·truststore · 구현 | Verified TLS enables PEM/JKS CA and PEM/PKCS#12 client identity fields; passphrases are prompted for the attempt. · **Add Database Connection** · **Edit Database Connection** · **Connect Database Profile** | v0.91 설치 시험 · 실제 두 DB에서 JKS의 CA와 호스트를 확인하고 별도의 PKCS#12로 상호 인증했다. 일반 leaf·private JKS 항목, 형식 대체, 잘못된 CA와 호스트를 거부했다. [시험 기록](../test/jks-truststore-host.js) |
| DG-010 | SSH 터널·키·agent 인증 · 구현 | Enable SSH in the profile editor, then select the agent/key/credential type and verified host key. · **Add Database Connection** · **Edit Database Connection** · **Test Database Connection** | v0.98 설치 시험 · 두 DB에서 정상 비밀번호·암호화 Ed25519 키, 불일치 지문 시 인증 차단, 내보내기 비밀 제외 및 소유 포워드 정리를 검증했다. [시험 기록](../test/ssh-credential-host.js) |
| DG-011 | Unix socket·Windows named pipe · 구현 | Transport picker includes Unix socket and Windows named pipe; the operator must use compatible OS/endpoint. · **Add Database Connection** · **Edit Database Connection** · **Test Database Connection** | v0.43 설치 시험 · 두 실제 서버에서 Windows 파이프를 재확인했다. 같은 드라이버의 Linux CI에서 TCP를 끄고 실제 MySQL·MariaDB 소켓과 바인딩 조회를 검증했다. [시험 기록](../test/local-transport-host.js) |
| DG-012 | 클라우드 DB 접속·토큰 인증 범위 · 부분 구현 | Database Connections의 **Add Database Connection** 또는 **Edit Database Connection**에서 AWS IAM과 Azure Entra 옵션을 선택한다. 실제 공급자 검증은 남아 있다. | v0.164 런타임 · 실제 AWS CLI의 합성 입력과 로컬 MySQL TLS 연결로 인증 흐름과 잘못된 CA의 거부를 확인했다. 테스트에 사용한 Azure 토큰 발급은 모의 공급자였다. [시험 기록](../test/cloud-mysql-auth-proof.test.js) |
| DG-013 | 초기 SQL·keep-alive·idle timeout · 구현 | Session lifecycle fields for Initialization SQL, Keep-alive and Idle disconnect; reconnect/status through console commands. · **Add Database Connection** · **Edit Database Connection** · **Reconnect Console Session** | v0.65 설치 시험 · 실제 두 DB의 설치판에서 초기화 네 문장, 상태 유지, 유휴 종료, 활성 트랜잭션 보존과 롤백, 서버 세션 종료 및 별도 물리 재접속, 잘못된 초기화 거부를 확인했다. [시험 기록](../test/session-lifecycle-host.js) |
| DG-014 | 연결 그룹·환경 색상 · 구현 | Profile form Group and Color map to Database Connections groups and nested live session items. · **Add Database Connection** · **Open Dedicated Profile SQL Console** · **Reveal Profile SQL Console** | v0.75 설치 시험 · 실제 MySQL·MariaDB를 동시에 연결하고 그룹 색상, 세션 상태, 별도 카탈로그와 거래 격리를 확인했다. 편집기를 닫았다 다시 열어 미확정 값이 유지됐으며 승인 후 선택 세션만 닫아 롤백했다. 다른 연결과 활성 카탈로그를 이어서 사용했다. [시험 기록](../test/profile-session-tree-host.js) |
| DG-015 | 연결 복제·가져오기·공유 · 구현 | Connection tree or palette exposes explicit actions; duplicate opens new form, import/export use files. · **Duplicate Database Profile** · **Import Connection Profiles** · **Export Connection Profiles** | v0.66 설치 시험 · 두 실제 서버에서 같은 주소의 독립 접속, 새 프로필 자격 증명, 자격 증명 없는 v5 교환 파일, 이름 변경·건너뛰기, 오래된 가져오기 거부와 활성 연결 보존을 확인했다. [시험 기록](../test/connection-copy-host.js) |
| DG-016 | 연결·테이블 읽기 전용 보호 · 구현 | Write Protection in the profile form and read-only mode in the console guard subsequent SQL and grid actions. · **Add Database Connection** · **Edit Database Connection** · **Change Console Mode** | v0.60 설치 시험 · 두 실제 Spring DB에서 연결·그리드·SQL 스크립트 보호, 동시 트리거·외래 키 변경 차단, 자동 커밋 뒤 새 외래 키의 영향 반영, 수동 롤백과 명시적 커밋을 검증했다. [시험 기록](../test/write-protection-host.js) |

#### 메타데이터·탐색

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-017 | introspection 대상 schema 선택 · 구현 | Schema Catalog view opens in the connected/trusted context and retains schema/exclusion preferences. Default collapsed. · **Choose Catalog Schemas** · **Hide This Catalog Object** · **Restore Hidden Catalog Object** | v0.59 설치 시험 · 설치 확장과 두 실제 서버에서 같은 이름의 표가 있는 두 스키마를 선택하고 정확한 DDL을 열었다. 한 스키마의 숨김을 다른 스키마와 분리하고, 재연결과 제한 계정의 범위 거부를 확인했다. [시험 기록](../test/schema-catalog-host.js) |
| DG-018 | 로컬 메타데이터 cache·오프라인 재사용 · 구현 | Save with a live connection, open from the palette while disconnected, browse metadata in Database and complete SQL offline. · **Save Database Metadata for Offline Use** · **Open Cached Database Metadata** · **Close Cached Database Metadata** | v0.43 설치 시험 · MySQL·MariaDB 실제 카탈로그 저장 후 VS Code 재시작과 연결 없는 완성을 확인했다. 같은 연결의 일치 후 실제 ALTER TABLE이 이전 캐시를 무효화했다. [시험 기록](../test/metadata-cache-host.js) |
| DG-019 | 전체·증분·객체별 refresh · 구현 | Database or Schema Catalog title commands plus selected object refresh. Per-object routine/event refresh remains a model boundary. · **Refresh Workspace and Schema** · **Refresh Changed Database Objects** · **Refresh Selected Database Objects** | v0.58 설치 시험 · 두 실제 Spring DB에서 외부 DDL로 추가한 제약조건과 열, 다른 객체 변경을 설치 명령과 지연 카탈로그에서 확인했다. 동시 작업 거부와 관련 오프라인 캐시 무효화를 확인했다. [시험 기록](../test/catalog-refresh-host.js) |
| DG-020 | 이름 우선·지연 상세 로딩 · 구현 | Browse Database Object Names picker identifies and previews a selected table/view, independent of the compact main tree. · **Browse Database Object Names** · **Open Database Object Source** | v0.33 설치 시험 · 두 실제 DB에서 Spring 객체의 첫 이름 페이지와 선택 테이블의 열·인덱스를 실제 카탈로그와 대조했다. 재연결 뒤 이전 페이지 접근을 거부했다. [시험 기록](../test/lazy-catalog.test.js) |
| DG-021 | 시스템 schema minicatalog · 구현 | Browse Database System Catalog takes a trusted live connection into schema/object selection. · **Browse Database System Catalog** | v0.32 설치 시험 · MySQL·MariaDB 각각에서 실제 계정이 관찰한 시스템 스키마·열과 performance_schema 상태를 직접 카탈로그 결과와 대조했다. [시험 기록](../test/database-admin-host.js) |
| DG-022 | 객체 이름·DDL·파일 검색 · 구현 | Database title or palette opens unified scope/search picker and exact source destinations. · **Search SQL Files, Database Objects and DDL** | v0.58 설치 시험 · MySQL 8.4.13과 MariaDB 11.4.8의 설치 확장에서 로컬 SQL 내용과 다른 스키마의 DDL, 테이블 DDL 내 열 위치로 이동했다. 연결·DDL 변경 뒤 이전 결과 열기를 거부하고 읽을 수 없는 정의를 구별했다. [시험 기록](../test/unified-search-host.js) |
| DG-023 | DDL·object source 보기 · 구현 | Database table/catalog node or palette opens read-only DDL; source editor action refreshes it. · **Open Database Object Source** · **Refresh Database Object Source** | v0.41 설치 시험 · MySQL 객체 7종과 MariaDB 10종에서 서버 원문과 열린 문서를 대조했다. 교차 스키마, SELECT 전용 계정의 뷰 원문 거부, 트리 열기와 새로 고침을 확인했다. [시험 기록](../test/object-source-host.js) |
| DG-024 | 루틴·인덱스·트리거·MariaDB package · 구현 | Schema Catalog group menus expose routines/triggers/packages; package call is a separate typed review action. · **Choose Catalog Schemas** · **Open Database Object Source** · **Inspect MariaDB Sequence** | v0.94 설치 시험 · 실제 Oracle 모드 공개 함수와 서명을 탐색하고 정밀 반환·OUT 값을 보존했다. 비공개 함수와 쓰기 시도, 오래된 본문·검토 재사용을 거부했으며 MySQL의 일반 루틴을 비교했다. [시험 기록](../test/routine-package-output-host.js) |
| DG-025 | 실제 FK 없는 관계 정의 · 구현 | Schema diagram logical-relations panel and cross-schema relationships command let users define logical column pairs. · **Open Schema Diagram** · **Manage Cross-Schema Logical Relationships** | v0.29 설치 시험 · 실제 MySQL·MariaDB에서 가상 FK가 같은 프로필의 재연결 뒤 복원되고 다른 연결에 나타나지 않음을 확인했다. 물리 키 중복은 거부했고 서버 DDL과 행을 대조했다. [시험 기록](../test/schema-erd-host.js) |
| DG-026 | virtual view·virtual column · 구현 | SQL editor commands select, store, apply, or exit a virtual schema preview. · **Preview SQL with a Virtual Schema** · **Manage Saved Virtual Schemas** · **Exit Virtual SQL Schema Preview** | v0.79 설치 시험 · 두 엔진에서 저장한 정의의 두 번째 버전을 다시 열고 다른 연결에서 사용할 수 없는지 확인했다. 교차 스키마 뷰, 생성한 DECIMAL 열의 완성과 실제 카탈로그 보존을 확인했다. 외부 원문 변경 후 가상 모델은 거부됐다. [시험 기록](../test/virtual-schema-overlays-host.js) |

#### SQL 의미 분석·편집

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-027 | schema-aware 이름·열 완성 · 구현 | 활성 DB의 SQL 편집기에서 스키마·컬럼 자동완성을 연다. 전용 프로필 콘솔의 완성에는 해당 프로필 카탈로그 연결이 필요하다. | v0.90 설치 시험 · 설치판에서 각 DB의 실제 다섯 완성 문장을 실행하고 롤백했다. 인식한 두 쓰기 소유자와 생성 열·중복 또는 모호한 별칭의 거부를 확인했다. [시험 기록](../test/sql-dml-completion-host.js) |
| DG-028 | FK 기반 JOIN/ON 자동 생성 · 구현 | SQL 편집기에서 JOIN 또는 ON을 작성할 때 외래 키 기반 자동완성을 연다. 전용 프로필 콘솔은 해당 프로필의 카탈로그가 필요하다. | v0.60 설치 시험 · 두 실제 엔진에서 Spring 테이블, CTE·파생 열 별칭, 중첩된 교차 스키마 복합 외래 키와 가상 관계로 완성한 JOIN을 실행했다. 인접 문장 유지와 가상 관계 삭제 뒤 제안 제거를 확인했다. [시험 기록](../test/db-scoped-joins-host.js) |
| DG-029 | SELECT·INSERT·GROUP BY 필드 목록 완성 · 구현 | SQL completion in supported empty/explicit SELECT, INSERT, GROUP BY field-list contexts. | v0.43 설치 시험 · 두 실제 서버에서 VS Code 제안으로 SELECT 4열, INSERT 2열, GROUP BY 1열을 채웠다. 완성한 세 쿼리를 실행한 후 삽입을 롤백했다. [시험 기록](../test/sql-field-lists-host.js) |
| DG-030 | alias·약어·함수 구문 완성 · 구현 | SQL completion and signature help in supported function calls, along with current-scope name/alias matches. | v0.82 설치 시험 · 설치판에서 스코프가 있는 별칭·CTE, 문자열과 주석 차단, 정확한 삽입 범위, 방언별 함수와 중첩 인수 안내를 확인했다. 완성한 표현식을 두 실제 서버에서 실행했다. [시험 기록](../test/sql-call-completion-host.js) |
| DG-031 | MySQL/MariaDB dialect별 구문·키워드 · 구현 | SQL editor diagnostics and completion/definition providers apply a supported dialect and command opens an explicit analysis route. · **Analyze Current SQL Document** | v0.100 설치 시험 · MariaDB 11.4.8의 반환 구문 여섯 개와 무효 사례 다섯 개를 실제 실행했다. MySQL 8.4.13의 무효 사례 열한 개, 선언한 ANSI_QUOTES 모드, 설치판 진단 및 반환 열 완성을 확인했다. [시험 기록](../test/sql-returning-host.js) |
| DG-032 | 파일·폴더별 SQL resolution scope · 구현 | Settings editor exposes rocketbrain.sql.analysis.resolutionScopes as object-array configuration; folder/file DDL mapping is edited in settings.json. No dedicated mapping picker found. | v0.33 설치 시험 · 실제 Spring 작업 공간에서 파일이 폴더 매핑을 재정의하고 저장한 DDL 변경을 반영했다. 파일이 사라지면 실제 카탈로그로 대체하지 않음을 확인했다. [시험 기록](../test/sql-resolution-scopes.test.js) |
| DG-033 | 현재 스크립트의 DDL 변화 인식 · 구현 | As a supported SQL document is analyzed, earlier statements overlay schema for IntelliSense/Problems; no DDL execution required. · **Analyze Current SQL Document** | v0.83 설치 시험 · 두 DB에서 열·인덱스 변경 다섯 사례와 정확한 DECIMAL을 실제 DDL 결과와 대조했다. 편집 중 물리 카탈로그 보존, 모드 변경에서 추론 중단, 수정 시 재분석을 확인했다. [시험 기록](../test/live-script-ddl-host.js) |
| DG-034 | 실시간·범위별 정적 검사 · 구현 | Problems/inline diagnostics from ordinary SQL analysis and optional collation checks, plus explicit analysis/refresh commands. · **Analyze Current SQL Document** · **Refresh SQL Analysis Metadata** · **Refresh SQL Collation Checks** | v0.87 설치 시험 · MySQL 23개와 MariaDB 22개 비트 표현식에서 실제 결과 타입·오류·경고를 확인했다. 설치판에서 피연산자·연산자의 정확한 위치와 수정 후 진단의 변경을 확인했다. [시험 기록](../test/sql-bitwise-checks-host.js) |
| DG-035 | 위험한 UPDATE/DELETE 경고 · 구현 | SQL diagnostics mark WHERE-less DML; Run or script review dispatches to a separate pre-execution guard. · **Run Selected SQL or Current Statement** · **Review SQL Script Before Running** · **Run SQL Script or Selection** | v0.42 설치 시험 · 두 엔진에서 편집기 경고와 사전 차단, 승인한 2행 변경과 수동 트랜잭션 롤백을 확인했다. [시험 기록](../test/sql-dml-scope-host.js) |
| DG-036 | schema-aware quick-fix·의도 동작 · 구현 | SQL Code Actions provider surfaces reviewed schema changes, JOIN correction and alias/schema intentions on the specific ranges. | v0.86 설치 시험 · 두 DB에서 두 스키마의 복합 JOIN 선택지와 제거된 제약·늦은 별칭·문서 변경 거부를 확인했다. 중첩 및 스키마 명시 이름의 수정을 검증했다. [시험 기록](../test/sql-context-fix-host.js) |
| DG-037 | 테이블·열·alias 의미적 Rename · 구현 | F2 in SQL dispatches to native Rename Provider for supported scope; database rename starts separate reviewed DDL/text-edit actions. · **Review and Rename Database Table** · **Review and Rename Database Column** | v0.93 설치 시험 · 실제 Java 문자열 결합·텍스트 블록을 Spring JDBC에서 컴파일하고, 정확한 세 열 참조만 수정하여 이웃 동명 컬럼·주석·별칭 보존과 두 DB에서 변경 전후 조회를 확인했다. [시험 기록](../test/java-sql-schema-rename-host.js) |
| DG-038 | 의미적 Find Usages·영향 추적 · 구현 | Native References, project SQL usage commands and catalog/routine usage picker with source jumps. · **Find SQL References in Query Roots** · **Show SQL Usage Coverage** · **Find Database Catalog Usages** | v0.97 설치 시험 · 동일 이름 개체 구분, 교차 스키마 루틴 두 곳과 SQL 파일 한 곳, 동적/숨은 범위 표시, 원본 또는 SQL 모드 변경 후 탐색 거부를 두 DB에서 확인했다. [시험 기록](../test/catalog-usages-host.js) |
| DG-039 | SQL 참조→정의·DDL·빠른 설명 · 구현 | SQL 편집기에서 F12와 정의 이동을 사용한다. 실행 중인 연결과 SQL 문맥이 대상을 결정한다. 전용 프로필 경계는 아래에 기록했다. | v0.80 설치 시험 · 두 실제 엔진에서 두 단계 교차 스키마 뷰와 중첩 별칭을 통과해 물리 열에 도달했다. 바뀐 뷰 정의, 식과 집합 연산은 원본으로 표시하지 않았다. [시험 기록](../test/sql-column-origin-host.js) |
| DG-040 | dialect별 SQL formatting · 구현 | SQL editor Format SQL command and native document/range formatter where supported; style and keyword casing in Settings. · **Format SQL** | v0.51 설치 시험 · 두 실제 DB에서 원본과 두 포맷의 각 100개 문을 실행해 결과 일치와 재포맷 안정성을 확인했다. IF, CASE, WHILE, REPEAT, LOOP, 트리거·함수와 여러 DELIMITER 스타일을 포함했다. [시험 기록](../test/sql-format-script-host.js) |
| DG-041 | live template·snippet·문맥 변수 · 구현 | Insert SQL Template picker and source-editor SQL snippet completion deliver the templates. · **Insert SQL Template** | v0.31 설치 시험 · 실제 Spring 테이블을 선택해 네이티브 편집기에 템플릿을 삽입하고 두 서버에서 결과 열과 행을 확인했다. [시험 기록](../test/sql-editing.test.js) |
| DG-042 | 문자열 안 SQL/JSON 언어 주입 · 구현 | Java/XML/SQL editor on a supported literal opens a temporary SQL/JSON/other language document then a reviewed diff. · **Edit Embedded Language** · **Review and Apply Embedded Source Edit** | v0.44 설치 시험 · 두 DB의 실제 Spring 작업 공간에서 원본 범위, SQL 완성·정의, 오래된 검토 거부를 검증했다. 반영한 SQL을 Spring JDBC와 MyBatis로 실행했고, 따옴표와 역슬래시를 포함한 JSON을 실제 서버에서 읽었다. [시험 기록](../test/embedded-language-host.js) |
| DG-043 | 쿼리 parameter 입력·재사용 · 구현 | Parameterized statement dialog and saved typed presets. · **Run SQL with Typed Parameters** · **Save SQL Parameter Preset** · **Remove SQL Parameter Preset** | v0.60 설치 시험 · 두 실제 Spring DB에서 정확한 BIGINT·DECIMAL 값으로 저장과 검토를 수행했다. 다른 계정·프로필 및 타입이나 SQL 변경 뒤 재사용을 거부하고 명시적 승인 뒤 실행하는지 확인했다. [시험 기록](../test/parameter-presets-host.js) |

#### 쿼리 실행·세션

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-044 | 현재 문장·선택 SQL 실행 · 구현 | Open SQL Console, select statement or place caret, Ctrl+Enter / ▶ editor toolbar, then Query Results. · **Open SQL Console** · **Run Selected SQL or Current Statement** · **Focus Query Results** | v0.61 설치 시험 · 실제 두 Spring DB의 설치 SQL 편집기에서 일반 커서 실행과 복합 문장 전체 선택, 지시문 위치와 불완전 선택 거부, 인접 DDL 제외를 확인했다. · 0.177.0에서 실제 Ctrl+Enter로 오프라인 샘플 3행을 표시했다. 세미콜론 뒤에서는 결과가 나오지 않았다. [시험 기록](../test/sql-current-statement-host.js) |
| DG-045 | 전체 스크립트·batch·오류 처리 · 구현 | Script review/run actions populate separate captured statement results and allow reopening retained results. · **Review SQL Script Before Running** · **Run SQL Script or Selection** · **Open Retained Script Statement Result** | v0.82 설치 시험 · 설치판의 두 실제 엔진에서 정밀 BIGINT·DECIMAL 입출력과 출력 전용 호출을 검증했다. 호출자 변수 보존, 원문 변경 시 거부, 검토의 재사용 차단을 확인했다. [시험 기록](../test/sql-script-output-host.js) |
| DG-046 | 같은 세션·temporary table 상태 유지 · 구현 | Dedicated/shared console identities keep regular temporary table and transaction state across commands in the same binding. · **Open SQL Console** · **Open Shared SQL Console** · **Run Selected SQL or Current Statement** | 소스 및 한정 실행 · 로컬 Oracle MySQL8.4.13·MariaDB11.4.8 fixture의 연결·세션·트랜잭션·카탈로그/편집 표본. TLS/클라우드 전체 인증 조합은 미검증이다. [관련 소스](../src/database-workbench.js) |
| DG-047 | 세션 공유·전용·introspection 분리 · 구현 | Database Connections에서 **Open Dedicated Profile SQL Console**을 실행한다. 파일은 **Bind SQL File to Database Profile**로 묶는다. 프로필 실행 세션과 이미 연결된 공용 카탈로그는 별개다. | v0.64 설치 시험 · 두 실제 DB의 설치판에서 같은 이름의 두 스키마 테이블과 별도 연결을 구분했다. 카탈로그 연결 해제 뒤 전용 트랜잭션을 유지했고 권한 보호·롤백·종료된 세션의 재사용 거부를 확인했다. [시험 기록](../test/dedicated-profile-console-host.js) |
| DG-048 | 수동 commit/rollback·auto-commit 전환 · 구현 | Change Console Mode and run transaction commands, or select console in session picker. · **Change Console Mode** · **Begin Console Transaction** · **Commit Console Transaction** | 소스 및 한정 실행 · 로컬 Oracle MySQL8.4.13·MariaDB11.4.8 fixture의 연결·세션·트랜잭션·카탈로그/편집 표본. TLS/클라우드 전체 인증 조합은 미검증이다. [관련 소스](../src/database-workbench.js) |
| DG-049 | 트랜잭션 격리 수준 선택 · 구현 | Console picker for transaction isolation then display current details. · **Set SQL Session Isolation** · **Show Console Session Details** | v0.28 설치 시험 · 최종 v0.28.0 VSIX, 실제 Spring과 MySQL 8.4.13·MariaDB 11.4.8에서 네 가지 서버 설정, 다른 콘솔 격리, 현재 트랜잭션과 데이터 초안 보호 및 이전 검토의 설정 변경 거부를 확인했다. [시험 기록](../test/db-session-tools-host.js) |
| DG-050 | 실행 취소·connection 종료 · 구현 | Cancel in editor while running; reconnect or close the exact console from session actions. · **Cancel Console Query** · **Reconnect Console Session** · **Manage Console Sessions** | 소스 및 한정 실행 · 로컬 Oracle MySQL8.4.13·MariaDB11.4.8 fixture의 연결·세션·트랜잭션·카탈로그/편집 표본. TLS/클라우드 전체 인증 조합은 미검증이다. [관련 소스](../src/database-workbench.js) |
| DG-051 | 쿼리 이력·검색·재실행 · 구현 | Query History picker shows retained entries and reopens/reuses selected SQL in an editor. · **Query History** · **Run Selected SQL or Current Statement** | v0.30 설치 시험 · 실제 두 DB에서 사용자 SQL 기록, 검색·삭제·전체 지우기, 같은 연결의 재실행과 불일치 거부를 확인했다. 스크립트·바인딩 입력과 재실행은 기록에서 제외했다. [시험 기록](../test/query-history-host.js) |
| DG-052 | 전체 SQL 로그·메타데이터 요청 기록 · 구현 | Show SQL Activity Log opens an activity webview with operation filters, details and an export option. · **Show SQL Activity Log** | v0.73 설치 시험 · 두 실제 DB에서 디자이너 DDL, 암호를 포함하는 승인된 계정 생성, 카탈로그와 세션 작업이 유형만 남기는 것을 확인했다. 메타데이터 호출이 몰려도 최근 제출 변경이 유지됐고 보관 설정, 초기화 및 비활성화를 확인했다. [시험 기록](../test/sql-activity-durable-host.js) |
| DG-053 | 즐겨찾기·저장 쿼리·다시 실행 · 구현 | Save SQL Query in active SQL editor, then select saved query to open/run. · **Save SQL Query** · **Saved SQL Queries** · **Run Selected SQL or Current Statement** | v0.30 설치 시험 · 실제 두 서버에서 태그 검색, 저장 프로필 바인딩과 재연결, 연결 불일치 거부를 확인했다. 쿼리 내용은 선택한 SQL 그대로 보존됐다. [시험 기록](../test/query-history.test.js) |
| DG-054 | 여러 result set·탭 유지·고정 · 구현 | Query Results tabs display script outputs. Pin Result, Rename Result and Close Result are click actions in the panel. · **Focus Query Results** · **Show Query Results** · **Open Retained Script Statement Result** | v0.33 설치 시험 · 이후 스크립트 여덟 건과 실제 DB 변경 뒤에도 두 원본 문장의 캡처가 보존됐고 같은 결과 탭을 재사용했다. [시험 기록](../test/db-results-v33-host.js) |

#### 실행 계획

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-055 | EXPLAIN 원본·tree/table · 구현 | Select a compatible current statement; execution-plan panel has plan tree/table and original plan. · **Visualize SQL Execution Plan** | v0.33 설치 시험 · 실제 Spring JOIN에서 두 서버의 원본 JSON을 직접 쿼리와 대조했다. MySQL의 TREE 원문과 선택 SQL의 정확한 위치도 확인했다. [시험 기록](../test/explain-plan-host.js) |
| DG-056 | 시각 실행 계획·cost graph · 구현 | Execution plan view and captured plan comparison show graphical costs and/operators when reported. · **Visualize SQL Execution Plan** · **Compare Captured SQL Plans** | v0.40 설치 시험 · 양쪽 실서버에서 저장한 두 시리즈를 별도 VS Code 프로필에서 열고 선택과 제외를 각각 승인 또는 건너뛰었다. 순서나 후보 근거가 맞지 않으면 거부했다. [시험 기록](../test/explain-review-foreign-host.js) |
| DG-057 | EXPLAIN ANALYZE 실제 실행 통계 · 구현 | Measured plan actions require a compatible active connector/statement, explicit review and supported EXPLAIN format. · **Measure SQL Execution Plan** · **Measure SQL Plan Series** · **Compare SQL Measurement Series** | v0.40 설치 시험 · MySQL TREE와 MariaDB JSON 표본을 저장하고 연결이 없는 별도 프로필에서 원본을 열었다. 재승인 후 캡처와 원문 표본이 유지됐다. [시험 기록](../test/explain-review-foreign-host.js) |

#### 쿼리 실행·세션

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-058 | 편집기 안 결과·SQL notebook 대안 · 구현 | Create SQL Notebook, execute via native notebook Run Cell, then pin/open retained results. · **New SQL Notebook** · **Pin SQL Notebook Result** · **Unpin SQL Notebook Result** | v0.41 설치 시험 · 실제 MySQL과 MariaDB에서 셀 순서, 쓰기 거부와 이후 실행 중단을 확인했다. 고정한 결과 하나만 파일에 저장하고 연결 없이 공유 사본을 열어 복원했다. [시험 기록](../test/sql-notebook-host.js) |

#### 데이터 그리드

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-059 | 페이지 이동·row limit·지연 조회 · 구현 | Select a named Database table; result Browse controls expose count/page and consistent snapshot enables continuous rows. · **Preview Table** · **Open Consistent Table Snapshot** | v0.72 설치 시험 · 두 DB의 실제 정렬 21행과 전후 스크롤 순서를 비교했다. NULL, 선언되지 않은 빈 ENUM, 64비트 SET과 53비트 한계 밖의 기본 키를 보존했다. 제한된 페이지 창, 내부 커서 열 숨김, 오래된 요청과 외부 동시 변경의 격리를 확인했다. [시험 기록](../test/grid-continuous-host.js) |
| DG-060 | 서버 정렬·다중 column 정렬 · 구현 | Named table result Browse controls show sort rules, presets and refresh to apply server order. · **Preview Table** · **Open Consistent Table Snapshot** | v0.77 설치 시험 · 두 실제 DB에서 29행을 JSON 정수·불리언·텍스트 기준으로 각각 10페이지씩 양방향 탐색했다. 큰 정수, UTF-8 바이트와 후행 공백, NULL, 혼합 collation, 기본 키 동률 해소와 숨긴 커서 열을 확인했다. [시험 기록](../test/grid-json-sort-host.js) |
| DG-061 | WHERE·column filter·검색·저장 filter · 구현 | Browse controls include selected table filter/search, filter groups, and named saved filters. · **Preview Table** · **Open Consistent Table Snapshot** | v0.33 설치 시험 · 두 실제 서버에서 정확한 소수·SQL NULL·리터럴 wildcard 그룹을 확인했다. 테이블 재열기 뒤 저장한 조건이 실행됐으며 진행 중 트랜잭션은 변경을 차단했다. [시험 기록](../test/db-results-v33-host.js) |
| DG-062 | 셀 직접 편집·저장·충돌 확인 · 구현 | Open a supported editable table; enable write mode in the owning session if required. F2/Enter or double-click cell, stage, review/apply. · **Preview Table** · **Change Console Mode** | 소스 및 한정 실행 · 실제 MySQL/MariaDB InnoDB table의 제한된 행·typed edit·추가/삭제·충돌·검토/commit 표본과 export 형식 검사. [관련 소스](../src/table-editor.js) |
| DG-063 | pending DML 미리보기·변경 되돌리기 · 구현 | Query Results Pending Review / apply and discard are real webview actions, with saved review recovery by command. · **Preview Table** · **Save Table Edit Review** · **Open Saved Table Edit Review** | 소스 및 한정 실행 · 실제 MySQL/MariaDB InnoDB table의 제한된 행·typed edit·추가/삭제·충돌·검토/commit 표본과 export 형식 검사. [관련 소스](../src/table-editor.js) |
| DG-064 | 행 추가·삭제·복제·일괄 붙여넣기 · 구현 | Editable table results expose Add Row, staged-delete and duplicate actions and bulk paste controls. · **Preview Table** · **Change Console Mode** | v0.79 설치 시험 · 두 실제 DB에서 정렬·필터 순서를 유지한 3페이지의 4행을 정확한 BIGINT·DECIMAL로 검토했다. 기존 충돌은 거부하고 커밋·롤백을 확인했다. 중간 서버 제약 실패와 외부 행 변경 시 전체 적용이 취소됐다. [시험 기록](../test/grid-multipage-paste-host.js) |
| DG-065 | NULL·긴 text·JSON·binary 값 편집 · 구현 | Editable grid and record value editor support explicit SQL NULL and supported typed text/JSON/binary entry. · **Preview Table** · **Change Console Mode** | v0.30 설치 시험 · 브라우저에서 LF·CRLF·CR 및 혼합 줄바꿈 편집을 확인했다. 실제 두 서버의 커밋에서 줄바꿈·NUL·JSON 큰 숫자·바이너리·NULL 표현을 대조했다. [시험 기록](../test/results.test.js) |
| DG-066 | FK 따라 관련 행으로 이동 · 구현 | Related Rows appears next to row or in record actions only for eligible named objects; result panel keeps a return-to-source row action. · **Preview Table** · **Manage Cross-Schema Logical Relationships** | v0.67 설치 시험 · 두 DB의 설치판에서 교차 스키마 복합 키로 SQL 결과와 양방향 그리드를 열고 원위치로 복귀했다. 프로필 격리와 재접속, PK·열 타입과 오래된 검토 거부, 관계 제거 및 서버에 FK가 추가되지 않음을 확인했다. [시험 기록](../test/cross-schema-logical-host.js) |
| DG-067 | record·tree·text·transpose 보기 · 구현 | Result View selector chooses Grid, Record, Tree, Text and Transpose where shape permits. · **Show Query Results** | v0.29 설치 시험 · Chromium에서 Grid와 Record 사이의 양방향 변경 반영·보기 전환·검토 입력을 확인했다. 실제 MySQL·MariaDB에서는 검토·Apply·Rollback과 원본 행 보존을 확인했다. [시험 기록](../test/results.test.js) |
| DG-068 | 컬럼 고정·숨김·순서·폭 조절 · 구현 | Columns panel provides Show/Pin/reorder/width controls; table-specific saved layout is separate from result-local layout. · **Preview Table** · **Show Query Results** | v0.30 설치 시험 · 저장 프로필의 내부 표시 정보에서 연결 식별값을 전달하도록 수정했다. 두 실제 DB의 저장 프로필을 재연결한 뒤 같은 테이블의 배치 복원 확인을 추가했다. [시험 기록](../test/result-layouts.test.js) |

#### 가져오기·내보내기

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-069 | CSV/TSV·clipboard 내보내기 · 구현 | Copy TSV and Export buttons are in the result panel; current retained selection/results determine content. · **Show Query Results** | 소스 및 한정 실행 · 실제 MySQL/MariaDB InnoDB table의 제한된 행·typed edit·추가/삭제·충돌·검토/commit 표본과 export 형식 검사. [관련 소스](../src/table-editor.js) |
| DG-070 | INSERT/JSON/Excel 등 출력 형식 · 구현 | Format dropdown and Export button handle INSERT, JSON, Excel and other advertised formats; INSERT asks for a verified destination. · **Show Query Results** | v0.28 설치 시험 · 최종 v0.28.0 VSIX, 실제 Spring과 MySQL 8.4.13·MariaDB 11.4.8에서 두 DB의 BIGINT·DECIMAL·JSON·BLOB·BIT·시간·유니코드를 내보냈다. Excel을 다시 읽고 호환 임시 테이블에 생성된 INSERT를 재실행해 값을 대조했다. [시험 기록](../test/results.test.js) |
| DG-071 | 사용자 data extractor 스크립트 · 구현 | New data extractor command opens model/script; result Format dropdown offers Export with Extractor. · **Create Data Extractor** · **Export with Data Extractor** | v0.46 설치 시험 · 두 실제 DB의 캡처된 결과에서 BIGINT, DECIMAL, 바이너리, 한글, NULL과 정확한 합계를 같은 339바이트로 내보냈다. VS Code 미리보기와 전체 출력의 동일성을 검증했다. [시험 기록](../test/data-extractor-host.js) |
| DG-072 | CSV/Excel import·column/type mapping · 구현 | Grid stage-file action for bounded CSV/XLSX and separate large import review through command palette and file mapping UI. · **Preview Table** · **Review and Stream a Large Data Import** · **Commit Pending Streamed Import** | v0.95 설치 시험 · 두 DB에서 UTF-16 TSV·CSV 1,201행씩을 검증했다. 또 205행 표본에서 202행 삽입과 3행 중복을 확인하고, 오류·취소에서 전체 롤백, 명시적 커밋 전 다른 세션에서 비가시성을 검증했다. [시험 기록](../test/utf16-delimited-import-host.js) |
| DG-073 | 다른 DB/table로 데이터 복사 · 구현 | Selected table or palette actions capture, select destination, review transfer and verify exact observed results. · **Capture Table Copy Source** · **Copy Captured Rows** · **Finish Table Copy** | v0.40 설치 시험 · MySQL과 MariaDB 양방향으로 144개 키를 9배치 대조하고 취소·완료 기록의 재시작 복원을 확인했다. 두 서버의 검증용 트랜잭션에서 조건부 SQL의 쓰기와 거부를 확인한 후 롤백했다. [시험 기록](../test/table-transfer-checkpoint-host.js) |
| DG-074 | native dump·restore 도구 통합 · 구현 | Palette commands open native tool/file selection and typed restore review; depends on compatible locally available binary and trusted connection. · **Create Native Database Dump** · **Review and Restore Native Dump** | v0.49 설치 시험 · 두 실제 DB에서 일곱 객체를 복원하고 중첩 뷰와 함수 실행, 트리거 순서 및 프로시저 호출을 확인했다. 스키마를 넘는 참조와 다른 콜레이션을 거부했다. [시험 기록](../test/native-dump-graph-host.js) |

#### 데이터 비교

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-075 | table·result dataset 비교·sync · 구현 | Result Compare view or saved table compare command opens mapping/review, then stages eligible updates on editable named table. · **Save Query Result Snapshot** · **Open Saved Query Result** · **Compare Saved Query Results** | v0.89 설치 시험 · 두 설치판에서 정확한 복합 키·NULL·타입과 중복 별칭·키 처리, 500행 캡처 한도, 양쪽 분류를 확인했다. 테이블 묶음에서 취소와 스키마 변경 후 부분 결과, 원본 행 보존을 검증했다. [시험 기록](../test/saved-result-compare-host.js) |

#### 데이터 시각화

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-076 | 그리드 결과 차트·집계 · 구현 | Result View > Chart uses group/type/value controls and scoped aggregate/export actions. · **Show Query Results** | v0.30 설치 시험 · Chromium에서 차트와 범주 페이지 이동을 확인했다. 실제 두 DB의 정밀 DECIMAL 집계에서 합계 0.000000000000004와 분수 평균을 확인했다. [시험 기록](../test/result-analysis.test.js) |
| DG-077 | 지리 데이터 지도 보기 · 구현 | Result View > Map requires a result with eligible geographic typed data, and can open the selected record. · **Show Query Results** | v0.41 설치 시험 · 두 서버의 캡처에서 지리 도형 3행·평면 도형 1행과 표시 제외 2행을 대조했다. 축 순서, 재투영, 다각형 내부 구멍, 연결 종료 후 지도 유지도 확인했다. [시험 기록](../test/result-map-host.js) |

#### 스키마·DDL

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-078 | table create/alter 시각 designer · 구현 | Database toolbar/create or table context/edit opens Table Designer webview and reviewed change action. · **Create Table with Designer** · **Modify Table with Designer** | v0.96 설치 시험 · 생성 자식 키와 뒤쪽 생성 인덱스 열을 포함한 실제 복합 FK를 MySQL·MariaDB에서 생성·변경·복구했다. 고아 행 차단, CASCADE·SET NULL 및 각 엔진의 제한을 검증했다. [시험 기록](../test/generated-composite-foreign-key-host.js) |
| DG-079 | PK·FK·index·제약조건 편집 · 구현 | Table Designer columns/indexes/foreign keys panel and reviewed SQL execute constrained supported edits. · **Create Table with Designer** · **Modify Table with Designer** | v0.88 설치 시험 · MySQL 함수 키의 생성·재열기·재구성 및 원본 복구와 숨은 엔진 열을 복사하지 않는 것을 확인했다. MariaDB에서 해당 구문을 거부하고 생성 열 인덱스로 동일한 정밀 소수 조회를 확인했다. [시험 기록](../test/functional-index-host.js) |
| DG-080 | 사용자·역할·권한 관리 · 구현 | Admin actions appear in palette when trusted/connected and open individual scope/review pickers. No unified users/roles table required by bounded route. · **Inspect Database Account Access** · **Inspect Database Role Inheritance** · **Review Database Role Membership** | v0.93 설치 시험 · 두 DB에서 계정의 DEFINER 객체 다섯 개를 조사했고, 기존 로그인과 역할·운영 객체는 유지하며 신규 로그인 차단·복원을 확인했다. [시험 기록](../test/database-account-access-host.js) |
| DG-081 | routine·view source 수정·deploy · 구현 | Database/schema source action opens editable draft; reviewed/deploy/restore actions apply versioned server definitions. · **Open Database Source for Editing** · **Review Database Object Source** · **Deploy Reviewed Database Object Source** | v0.102 설치 시험 · 중첩 역할을 적용한 실제 호출자와 거부 대조, 종속 INVOKER 뷰·권한, 재연결 복구 및 검토 후 권한·기본 역할 변경 거부를 확인했다. [시험 기록](../test/function-role-deployment-host.js) |

#### 스키마 비교·이행

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-082 | 서로 다른 서버 schema/object 구조 diff · 구현 | Snapshot and selected scope picker lead to schema compare webview and read-back object-definition actions. · **Save Database Schema Snapshot** · **Compare Schema Snapshot with Options** · **Compare Saved Origin Profile with Active Database** | v0.176 오프라인 · 모의 프로필·서버 카탈로그와 VS Code 명령에서 원본과 대상의 방향, 연결 없는 비교, 대상 변경 시 적용 검토 거부를 확인했다. [시험 기록](../test/schema-diff-vscode.test.js) |
| DG-083 | 선택 변경의 migration DDL 생성·검토·실행 · 부분 구현 | **Open Editable Migration SQL Draft**와 **Apply Reviewed Schema Migration**을 사용한다. 검토 플랜과 복구 경로가 있다. 서버 간 원자적 DDL은 제공 범위 밖이다. | v0.176 오프라인 · 오프라인 테스트에서 변경 선택, 초안과 적용 검토 분리, MySQL·MariaDB 모의 카탈로그의 트리거 참조·순서·복원용 SQL과 변조된 복구 기록 거부를 확인했다. [시험 기록](../test/schema-diff-vscode.test.js) |

#### 오프라인 schema·버전 관리

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-084 | DDL 파일을 가상 DB 의미 모델로 사용 · 구현 | Preview SQL with a Virtual Schema picker selects a local DDL model or live base and routes subsequent editor semantics to that preview. · **Preview SQL with a Virtual Schema** · **Exit Virtual SQL Schema Preview** | v0.32 설치 시험 · 각 실제 Spring 검증에서 DB 연결을 내린 상태로 로컬 DDL을 붙이고 VS Code 완성을 확인했다. 미리보기 해제 후 연결 없음으로 돌아왔다. [시험 기록](../test/sql-ddl-model-host.js) |
| DG-085 | DB schema→정렬된 DDL 파일·VCS · 구현 | Database table/context or palette opens reviewed export destination/scope for ordered DDL files. Use VS Code Source Control after writing. · **Save Schema DDL** | v0.65 설치 시험 · 실제 두 DB에서 12개 DDL 단계를 검토 파일 그대로 빈 스키마에 복원했다. 루틴과 트리거 각 세 개의 정의·순서·소유자와 문자 설정, 변경 객체의 실제 Git diff, 지원 밖 객체 네 개의 생략을 확인했다. [시험 기록](../test/schema-ddl-programs-host.js) |

#### ERD·모델

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-086 | live schema ERD 생성·관계 탐색 · 구현 | Schema Diagram command or database table action opens webview; select relation and source/destination using diagram controls. · **Open Schema Diagram** | v0.29 설치 시험 · 실제 두 서버의 메타데이터를 사용해 복합 FK와 두 PK 열, 시작 테이블의 인접 탐색, 읽기 범위를 확인했다. [시험 기록](../test/schema-erd-ui.test.js) |
| DG-087 | diagram 출력·레이아웃 보존 · 구현 | Diagram toolbar offers saving/restoring layout and report/image export where supported. · **Open Schema Diagram** | v0.29 설치 시험 · Chromium에서 노드 이동, 관계 탐색과 PNG를 확인했다. 실제 두 DB에 연결한 VS Code에서 배치 JSON 왕복과 재연결 뒤 위치 복원, 만료된 다이어그램 저장 거부를 확인했다. [시험 기록](../test/schema-erd-ui.test.js) |

#### 오프라인 schema·버전 관리

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-088 | SQL 파일 Git·diff·변경 검토 · VS Code 재사용 | VS Code Source Control, editor diff, Git history and selected file context handle SQL files through native host surfaces. | VS Code 기본 기능 · VS Code 기본 기능·명령 연결의 문서/소스 기준. 원본과의 전체 동작 비교는 하지 않았다. [관련 소스](../src/navigation.js) |

#### AI·도구 연결

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-089 | schema 문맥의 자연어 SQL·설명 · 구현 | Trusted active MySQL/MariaDB context and configured reviewed local model show proposal/diff and disclosure panels. · **Draft SQL with Local Model** · **Explain SQL with Local Model** · **Explore Schema with Local SQL Model** | v0.106 설치 시험 · 실제 로컬 Qwen으로 읽기 SQL 두 차례, 결과 1행과 2행, 원본 편집기 다시 열기, 바뀐 FK 거부와 대화 기록을 확인했다. [시험 기록](../test/local-sql-exploration-host.js) |
| DG-090 | 외부 AI용 DB MCP·권한·결과 제공 · 구현 | Published dist/ide-mcp-server.js is launched as a subprocess by a separate configured MCP client. No Rocketbrain button is defined. | v0.52 설치 시험 · 실제 두 서버에서 Spring 행, BIGINT·DECIMAL의 정확한 비교, 바이너리·시간·JSON 결과, 범위·바이트 제한과 상속 쓰기 권한 거부를 확인했다. [시험 기록](../test/db-mcp-host.js) |
| DG-091 | 2026.3 Air·여러 agent 작업 검토 · 구현 | Review Database ACP Tasks picks external agents, scopes and a review; multi-agent/local proposal comparison has explicit inspect/apply steps. · **Review Database ACP Tasks** · **Compare Local SQL Proposals** | v0.104 설치 시험 · 실제 OpenCode·로컬 Qwen으로 독립 작업 두 개를 실행했다. 결과를 실제 양쪽 엔진에서 비교하고 변경된 복합 FK를 거부했다. [시험 기록](../test/acp-database-host.js) |

#### 2026.3 추가 범위

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-092 | 서로 다른 data source의 cross-database SQL · 구현 | Open supported federated query and bind two stored profiles through a reviewed selection. · **New Federated SELECT** · **Run Federated SELECT** | v0.46 설치 시험 · 실제 MySQL과 MariaDB 사이에서 53비트를 넘는 키, 중복, NULL 및 바인딩된 필터에 따른 입력 수를 검증했다. 활성 연결 상태를 보존했다. [시험 기록](../test/federated-select-host.js) |
| DG-093 | DuckDB dialect·함수·introspection · 구현 | Independent read-only DuckDB console, functions/catalog picks and workspace extension management. · **Open Local DuckDB Read-Only** · **New DuckDB Query** · **Run Read-Only DuckDB Query** | v0.73 설치 시험 · 두 Spring·DB 설치 환경에서 실제 DuckDB 1.5.6의 CSV와 타입 있는 Parquet를 열고 큰 정수, DECIMAL, 중첩 타입을 확인했다. 두 공식 확장을 설치해 읽기 쿼리에서 사용하고 갱신·제거했다. 깊은 Windows 경로, 원본 파일 보존, 일반 쿼리의 외부 파일 접근 차단을 확인했다. [시험 기록](../test/duckdb-host.js) |

#### 복원·작업 연속성

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-094 | 미실행 SQL·최근 파일·Local History 복원 · 구현 | Tracked draft recovery and retained review recovery commands; recent files/local history on the VS Code host. · **Track SQL Console as Draft** · **Restore SQL Draft** · **Save SQL Draft Checkpoint** | v0.74 설치 시험 · 두 실제 DB에서 UPDATE·DELETE·INSERT 보관안을 별도 VS Code 프로세스에서 열었다. 정확한 매개변수, 물리 서버와 실제 행, 외부 변경 거부, 새 검토, 직접 적용 후 롤백 및 원래 데이터 보존을 확인했다. [시험 기록](../test/grid-edit-recovery-host.js) |

#### 화면·조작

| ID | 기능과 상태 | 사용자 진입점 | 마지막 검증 이력 |
| --- | --- | --- | --- |
| DG-095 | DataGrip 전체 창·도구창의 정확한 배치 · 호스트 구조 제약 | 상태 표시줄 **DataGrip** 또는 팔레트 **Switch to DataGrip Mode**를 사용한다. Database·Database Connections·Schema Catalog 뷰로 전환한다. 호스트 창 전체 교체는 제공 범위 밖이다. | v0.177.0 설치 시험 · DB 사이드바와 공용 결과 창, 연결과 신뢰를 요구하는 카탈로그 표시 조건, 전체 도구로 돌아가는 전환을 확인한다. [검증 기록](verification.json) |
| DG-096 | SQL 단축키·명령·결과 panel 이동 · 구현 | SQL 편집기에서 Ctrl+Enter나 실행 버튼을 누른다. 아래 Query Results의 결과·셀을 선택하고 **Focus Query Editor**로 돌아간다. | v0.76 설치 시험 · 두 DB의 SQL 편집기에서 선택 실행과 커서 위치 문장을 실행하고 정확한 결과에서 원래 편집기·선택·커서를 복원했다. Chromium에서 탭 키보드와 접근성 상태도 확인했다. · 0.177.0에서 DataGrip 버튼과 SQL 콘솔을 열고 실제 Ctrl+Enter로 Query Results의 3행을 확인했다. [시험 기록](../test/results.test.js) |
