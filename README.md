# Rocketbrain

Java·Spring과 MySQL/MariaDB 작업을 VS Code에서 다루는 독립 확장입니다. **개발 미리보기이며 IntelliJ IDEA·DataGrip과의 전체 기능 동등성은 아직 검증되지 않았습니다.**

An independent VS Code workbench for Java/Spring and MySQL/MariaDB. Support is deliberately bounded; this project does not claim complete IntelliJ IDEA or DataGrip parity.

[GitHub](https://github.com/Fenrindale/Rocketbrain) · [216개 기능 현황](https://github.com/Fenrindale/Rocketbrain/blob/main/docs/FEATURES.md) · [공개 소스·빌드·검증 안내](https://github.com/Fenrindale/Rocketbrain/blob/main/docs/public-source.md) · [제품 경계](https://github.com/Fenrindale/Rocketbrain/blob/main/architecture/product-policy.json)

## 현재 범위

| 영역 | 제공하는 흐름 | 주요 제한 |
|---|---|---|
| Java | 독립 JDT LS의 언어 기능, 프로젝트·패키지 탐색, Maven/Gradle 빌드, 저장한 Run/Debug 구성, 검토 후 리팩터링 적용 | 모든 JDK·빌드 형태·복합 프로젝트를 검증한 것은 아닙니다. |
| 디버거·테스트 | Java launch/attach, 중단점·Watch·수동 Hot Code Replace, JUnit/TestNG 탐색·실행·디버깅, JVM 커버리지 | JVM 구조 변경, 모든 TestNG 확장, 다른 운영체제의 테스트 디버깅은 별도 범위입니다. |
| Spring·JPA | 소스 기반 Bean·설정·HTTP mapping·JPQL 분석, 선택한 실행 앱의 Actuator·Hibernate 관찰과 소스 비교 | 임의 Java·SpEL·provider 코드를 정적으로 실행하거나 모든 동적 경로의 결과를 보장하지 않습니다. |
| DB·SQL | 연결 프로필·TLS·SSH, 독립·공유 콘솔 세션과 트랜잭션, SQL 작성·실행·분석, 결과 그리드 편집·가져오기, 테이블 설계·객체 원문 편집, 스키마 비교·복구 | 동시에 여러 활성 연결, 모든 SQL 문법·객체 작성 형식·타입 변환, 서버 간 원자적 DDL은 완성되지 않았습니다. |
| VS Code 통합 | 기본 편집기·탐색·검색·Undo, 프로젝트/DB 트리, 분석·결과 화면 | 원본 IDE의 모든 화면과 작업별 사용성·대규모 성능 동등성을 뜻하지 않습니다. |

설치된 JetBrains 제품의 엔진·코드·복사한 화면 자산·내장 JBR을 사용하거나 배포하지 않습니다. 별도 JetBrains 구독이나 다른 Marketplace 확장을 요구하지 않습니다. 사용하는 공개 구성요소의 조건과 고지문은 [NOTICE](https://github.com/Fenrindale/Rocketbrain/blob/main/NOTICE.txt) 및 [third-party/licenses](https://github.com/Fenrindale/Rocketbrain/tree/main/third-party/licenses)에 보존합니다.

## 빌드와 설치

Node.js 22 또는 24 이상과 pnpm 10을 준비한 뒤 저장소 루트에서 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:offline
pnpm run package
```

생성된 `rocketbrain-<version>.vsix`를 VS Code 확장 메뉴의 **Install from VSIX…**로 설치합니다. 패키지 명령은 로컬 VSIX를 만들며 Marketplace에 자동 게시하지 않습니다. 확장 패키지에는 Java 엔진과 DB 서버 바이너리를 포함하지 않습니다.

`test:offline`은 실제 DB·Java·브라우저·VS Code 실행 환경을 요구하는 검사를 구분하여 제외하거나 건너뜁니다. 이 결과가 실제 Spring·MySQL·MariaDB 검증을 대신하지 않습니다. 실환경 도구와 별도 검증 조건은 [공개 소스 안내](https://github.com/Fenrindale/Rocketbrain/blob/main/docs/public-source.md)를 참고하세요.

## Java·Spring 시작

1. 신뢰하는 Java 프로젝트를 엽니다.
2. 명령 팔레트에서 **Rocketbrain: Install and Configure Independent Java Engine**을 실행합니다. 고정된 공개 구성요소의 출처와 체크섬을 확인하고 확장 전용 폴더에 설치합니다. 현재 설치 도구는 Eclipse JDT LS 1.63.0과 독립 Temurin JDK 25 계열을 사용합니다.
3. **Java Projects**에서 가져온 소스 루트·패키지·라이브러리를 확인합니다. Maven 작업에는 별도 Maven 설치와 `rocketbrain.java.mavenHome` 설정이 필요합니다.

Java 중단점에서 **Restart Java Stack Frame**으로 현재 정지한 스레드의 프레임을 선택해 메서드를 다시 실행할 수 있습니다. 이미 수행된 부수 효과는 그대로 남습니다. **Inspect Java Local Value**는 지역 배열과 표준 `ArrayList`를 페이지로 보여주고, 최대 256 Ki UTF-16 단위의 문자열을 원문 그대로 표시합니다. [Java 스택 프레임과 변수 뷰어](docs/java-frame-debugging.md)

Windows의 신뢰한 로컬 작업 영역에서 **List WSL Distributions and Map Workspace**로 배포판과 Linux 경로를 확인합니다. **Review and Run WSL Workspace Build**에서 프로젝트 경로와 명령을 확인한 뒤 배포판의 Maven 또는 Gradle을 실행합니다. 배포판 안에 Linux JDK와 `/usr/bin/mvn` 또는 `/usr/bin/gradle`이 필요합니다. **Cancel Managed WSL Build**로 실행한 빌드를 중단할 수 있습니다.

`rocketbrain.localCodeModel.endpoint`와 `.model`에는 로컬 모델 서버 주소와 모델 이름을 지정합니다. **Ask Local Code Model**은 선택한 코드에 대한 응답을 엽니다. **Request a Reviewed Local Edit**로 변경 내용을 비교하고, 검토한 편집은 **Apply Reviewed Local Edit**로 적용합니다.

표준 `src/main/resources`의 FXML에서 Outline을 볼 수 있습니다. 컨트롤러, 이벤트 메서드, `fx:id` 필드와 같은 모듈에 있는 포함 파일·리소스는 정의로 이동할 수 있습니다. **Run or Package JavaFX Application**에서 JavaFX Maven 플러그인이 구성된 모듈을 선택해 앱을 실행하거나 `jlink` 런타임 이미지를 만들 수 있습니다.

**Audit Maven Dependencies with OSV**는 선택한 Maven 모듈의 실제 의존성 트리를 해석합니다. OSV로 전송할 패키지 이름·버전을 직접 선택하면 직접·전이 의존 경로와 조회 시각, 등록된 권고 ID를 보고서에 표시합니다. [OSV API](https://google.github.io/osv.dev/post-v1-querybatch/)

`.ipynb`는 **Rocketbrain Jupyter Notebook**에서 열 수 있습니다. `jupyter_client`와 `ipykernel`이 설치된 Python 실행 파일을 `rocketbrain.jupyter.pythonPath`에 지정하면 셀을 실행하고 커널 세션을 유지할 수 있습니다. 셀 소스, 출력과 Markdown 첨부 파일은 노트북에 저장됩니다. [Jupyter 파일 형식](https://nbformat.readthedocs.io/en/v5.10.0/format_description.html)

**Docker** 보기에서 시스템 Docker CLI가 제공하는 컨텍스트를 선택해 컨테이너·이미지·Compose 프로젝트를 탐색할 수 있습니다. 컨테이너 로그와 승인된 시작·중지·재시작, 레지스트리 매니페스트 조회를 제공합니다. [Docker 워크벤치](docs/docker.md)

**Select Python Interpreter**로 프로젝트 가상환경을 선택합니다. Python Outline과 구문 오류는 해당 인터프리터의 AST에서 얻습니다. **Run Python File**로 저장한 파일을 실행하고 `debugpy`가 설치된 환경에서 **Debug Python File**로 중단점·변수를 볼 수 있습니다. [debugpy](https://github.com/microsoft/debugpy)
4. **Build Java Project / Choose Build Task**, 저장한 **Run / Debug / Stop** 구성을 사용합니다.
5. **Create Spring Project**로 공식 Initializr의 Java·Kotlin·Groovy JAR/WAR 프로젝트를 검토하고 생성합니다. **Edit Spring Starters**에서 지원하는 의존성 변경을 검토합니다. [Spring 프로젝트 만들기](docs/spring-initializr-project-forms.md) · [Maven BOM으로 관리하는 스타터](docs/spring-maven-bom-starters.md)
6. **New Java File from Template**에서 소스 루트·패키지·템플릿을 골라 파일을 만듭니다. Maven·Gradle 및 main·test에 맞는 사용자 템플릿과 저작권 프로필을 선택하고 필요한 변수 값을 입력할 수 있습니다. [Java 파일 템플릿](docs/java-file-templates.md)
7. **New JShell Scratch**로 저장할 코드를 만들고 **Run JShell Scratch**로 독립 JDK에서 실행합니다. 프로젝트 클래스가 필요하면 실행할 때 관찰된 로컬 클래스 경로를 선택합니다.
8. **Explore Java Call Hierarchy**와 **Explore Java Type Hierarchy**에서 JDT가 확인한 호출과 상속·구현 관계를 이동합니다. **Inspect Java Dependencies**는 소스 import, 선언된 빌드·모듈과 빌드된 클래스의 의존성을 구분해 순환 경로를 보여줍니다.
9. **Insert Java Live Template**과 `rocketbrain.java.liveTemplates`에서 Java 스니펫을 사용합니다. **Generate Java Members**에서 선택한 필드의 생성자·접근자·`equals`와 `hashCode` 또는 위임 메서드를 미리 보고 적용합니다.
10. **Record JVM Profile**, **Capture JVM Threads**, **Inspect JVM Heap Histogram**에서 로컬 JVM을 직접 선택합니다. 저장한 JFR과 스레드 스냅샷도 다시 열 수 있습니다. 일부 Windows JDK에서 JFR이 빈 파일을 보고하면, 대상 JVM을 쓰기 가능한 ASCII 경로의 JFR 저장소로 시작한 뒤 다시 녹화합니다. **Inspect JVM Heap Dump**는 로컬 HotSpot HPROF에서 객체와 수명 유지 경로를 탐색합니다. [JVM 힙 덤프 분석](docs/java-heap-dump.md)
11. **Run Java Inspection Profile**은 선택한 Java 소스 범위와 검사별 심각도를 VS Code Problems에 적용합니다. **Find Duplicate Java Code**는 정확한 토큰 일치 또는 리터럴을 무시한 후보를 표시하고 원본 범위를 엽니다. 사용자 프로필은 `rocketbrain.java.inspectionProfiles`에 저장합니다.
12. **Show Java Class Diagram**은 Javac가 확인한 상속·구현·중첩 타입 관계와 소스 링크를 표시하고 Mermaid로 내보냅니다. **Trace Java Local Value**는 직선형 메서드에서 지역값의 정의와 사용 범위를 연결합니다. 구조 편집, 분기 병합, 객체의 공유 참조와 메서드 간 흐름은 지원 범위 밖입니다.
13. **Search or Replace Java Structure**는 Java 파일이나 프로젝트에서 Javac AST 패턴을 찾습니다. `$name$`으로 식을 캡처하고 타입 제약을 지정합니다. 치환할 결과를 선택해 변경 내역을 검토하면 적용 전에 Javac로 새 소스를 검사합니다.
14. **Extract Java Interface**는 선택한 Java 클래스의 메서드로 같은 패키지에 인터페이스를 만듭니다. `rocketbrain.java.extractInterface.replaceUsages`를 켜면 호환되는 사용처 변경도 검토할 수 있습니다. 새 파일과 기존 소스 변경을 컴파일 검사와 diff에서 확인합니다.
15. **Show Spring Bean Dependency Graph**는 선택된 주입, 모호한 후보, 지연 조회를 구분합니다. 선택한 Bean의 의존 관계와 순환, 선언·주입 소스를 탐색합니다. **Open Spring Actuator Health**는 연결한 실행 앱이 공개한 상태, 그룹과 구성 요소를 확인합니다.
16. **Inspect Spring Property Value and Origin**으로 지정한 키의 실제 값과 출처 우선순위를 확인합니다. Windows에서 확인된 PID로 Java 디버거를 연결했다면 디버그 도구 모음에서 같은 Spring 프로세스의 설정을 조회할 수 있습니다. [Spring 설정값과 출처 조회](docs/spring-property-origin.md)
16. **Pull Up Java Members**와 **Push Down Java Members**는 같은 패키지에서 직접 상속하는 클래스 사이의 메서드·상수 이동을 미리 봅니다. Javac가 전후 참조를 비교하고 선언 충돌이나 다른 오버로드로의 연결을 감지하면 적용을 차단합니다.
17. **Manage Git Changelists**에서 변경 파일을 이름 있는 작업 목록에 배정합니다. 목록에 편집 위치와 실행 구성 선택을 기록해 복원할 수 있습니다. 복원 후 실행 구성은 VS Code의 Run and Debug에서 시작할 수 있습니다.

**Manage Git Worktree Context**에서 worktree별 Java 프로젝트, Spring Actuator 주소와 DB 프로필을 저장하고 그 문맥에서 작업합니다. [Git worktree별 프로젝트 문맥](docs/git-worktree-context.md)
   **Open GitHub or GitLab Review**는 `rocketbrain.codeReview`에 지정한 프로젝트의 열린 검토를 불러옵니다. 변경 패치와 댓글, 연결 이슈 번호와 CI 상태를 볼 수 있으며 **Add Local Review Draft**로 새 줄에 연결한 초안을 작업 공간에 저장합니다.
18. **Convert Java Lambda, Anonymous Class or Loop**에서 플랫폼 또는 프로젝트에 선언된 단일 추상 메서드 인터페이스를 구현하는 지역 변수와 배열 합산 루프의 변환을 검토합니다. 적용 전에 Javac로 캡처한 지역 값과 호출 오버로드의 바인딩을 확인합니다. [Java 변환](docs/java-conversions.md)
19. **Trace Java Stream Values**에서 `Stream.of` 또는 `List.of(...).stream()`부터 `toList()`까지 선택합니다. 독립 JDK에서 `filter`, `map`, `flatMap`, `limit`의 실제 값 흐름을 실행하고 **Go to Java Stream Stage**로 원본 단계에 이동합니다.
20. **Build and Index Mixed JVM Sources**로 가져온 Gradle·Maven 혼합 프로젝트의 표준 main 소스를 빌드하고 인덱싱합니다. Java Projects에서 Kotlin 파일을 열고, 한 줄에서 대상을 식별할 수 있는 호출·getter·상위 클래스에 **Go to Mixed JVM Declaration**을 사용합니다. 소스나 컴파일 결과가 바뀌면 다시 인덱싱합니다. Gradle `application` 프로젝트는 **Run Mixed Gradle Application**에서 실행합니다.
21. Java Projects에서 Groovy 패키지와 파일을 엽니다. **Run Groovy and Spock Tests**는 가져온 Gradle 프로젝트의 `test` 작업을 실행합니다. **Groovy Console**과 **Evaluate Groovy Selection**은 함께 사용하는 세션에서 변수를 보존하며, **Reset Groovy Console**로 초기화합니다. **Run Groovy Script**는 저장한 파일을 별도 JVM에서 실행하고 구문 오류를 Problems에 표시합니다. 콘솔과 스크립트 실행에는 Gradle 홈에 포함된 Apache Groovy 4.0.28 또는 사용자 설정 `rocketbrain.java.groovyConsoleJar`의 공식 코어 JAR를 사용합니다.

**JPA: Show Entity Relationship Diagram**으로 워크스페이스 선언이나 실행 중인 Hibernate의 엔티티 관계를 엽니다. 엔티티 연결과 매핑 선언을 탐색하고, 카드 위치와 숨김 상태를 워크스페이스에 저장합니다. [JPA 관계도 사용 범위](docs/jpa-relationship-diagram.md)

**Inspect Spring Security Runtime**은 연결한 로컬 Actuator의 `beans`, `conditions`, `auditevents`를 읽습니다. Security 필터 체인 Bean과 조건, 애플리케이션이 기록한 인증 성공·실패와 인가 거부를 확인합니다. 감사 조회는 시간 범위·이벤트 유형·주체로 좁힐 수 있습니다. 앱에서 감사 저장소를 구성하고 연결 계정에 관리 엔드포인트의 읽기 권한을 부여해야 합니다.

Spring Boot 설정 파일에서 현재 모듈의 생성 메타데이터로 설정 키를 완성하고 Java 선언을 엽니다. 여러 YAML 문서와 프로필별 출처를 지원합니다. [Spring 설정 메타데이터](docs/spring-configuration-metadata.md)

**Configure Spring Boot Run**에서 프로필과 설정별 전달 출처를 정한 뒤 Java Projects의 Run·Debug로 실행합니다. [Spring Boot 실행 설정](docs/spring-boot-run-configurations.md)

**Inspect Spring Security Filter Trace**는 관찰을 켠 로컬 앱에서 요청별 매처 순서, 선택된 체인, 실제 실행에 들어간 필터와 관찰된 인가 결과를 표시합니다. 메서드 추적을 켜면 호출 전·후 판단과 실제 역할 비교 근거도 확인할 수 있습니다. [Spring Security 추적 설정](docs/spring-security-filter-trace.md)

### Quarkus Maven

**Create Quarkus Maven Project**로 시작 프로젝트를 만든 뒤 **Java Projects**에서 가져옵니다. 시작 프로젝트는 JDK 25와 Maven을 사용합니다. `application.properties`에서 Java에 선언된 MicroProfile Config와 SmallRye ConfigMapping 키를 완성하고 선언으로 이동할 수 있습니다. **Inspect Quarkus Configuration and Endpoints**에서는 프로필별 키, REST 경로와 Qute 템플릿을 엽니다.

**Start Quarkus Dev Mode**는 루프백에서 개발 서버가 준비되면 주소를 표시합니다. **Stop Quarkus Dev Mode**로 세션을 종료하고 **Run Quarkus Tests**로 Maven 테스트를 실행합니다. 이 흐름은 모듈 POM에 Quarkus 3 플러그인을 직접 선언한 프로젝트와 리터럴 어노테이션을 지원합니다.

### Jakarta WAR 배포

독립 Apache Tomcat 11 설치 경로를 사용자 설정 `rocketbrain.java.jakarta.tomcatHome`에 지정합니다. Java Projects로 가져온 Maven WAR 모듈에서 **Build Jakarta WAR**를 실행한 뒤 **Deploy Jakarta WAR to Tomcat**으로 `target`의 WAR와 컨텍스트 이름을 선택합니다. **Show Jakarta Deployment**에서 로컬 주소와 출력을 확인하고 **Stop Jakarta Deployment**로 서버를 종료합니다.

**Debug Jakarta WAR on Tomcat**은 Rocketbrain Java 디버거로 관리 중인 로컬 Tomcat JVM에 연결합니다. 배포에는 선택한 WAR의 별도 임시 복사본과 루프백 포트를 사용합니다. 이 흐름은 로컬 Tomcat 11의 Jakarta Servlet·JSP WAR를 지원합니다.

### Micronaut Maven

Micronaut 5 Maven 플랫폼 부모를 선언한 JAR 모듈을 **Java Projects**로 가져옵니다. **Inspect Micronaut Application**에서 타입이 지정된 설정 키, 환경별 설정 파일, HTTP 경로와 생성자 연결의 소스를 엽니다. `application*.properties`에서 키 완성과 선언 이동을 사용하고, 단일 문서 YAML의 스칼라 키에서 선언으로 이동합니다.

**Run Micronaut Tests**는 Maven 테스트를 실행합니다. **Build and Run Micronaut**는 선택한 환경으로 실행 가능 JAR를 패키징하고 루프백 주소를 표시합니다. **Stop Micronaut Application**으로 실행 중인 JVM을 종료합니다. 소스 변경을 반영하려면 다시 빌드하고 실행합니다.

### Scala · sbt

독립 JDK와 [공식 sbt 1.13.1 런처](https://repo.maven.apache.org/maven2/org/scala-sbt/sbt-launch/1.13.1/sbt-launch-1.13.1.jar)를 준비하고 사용자 설정 `rocketbrain.scala.sbtLauncher`에 JAR 경로를 지정합니다. **Discover sbt Projects**는 `build.sbt`의 실제 하위 프로젝트를 표시합니다. **Run sbt Tests**와 **Run sbt Main Class**에서 실행할 프로젝트와 진입점을 선택합니다. 실행 출력은 **Rocketbrain Scala / sbt**에서 확인합니다.

Scala 3 프로젝트에서 `semanticdbEnabled := true`를 설정한 뒤 **Compile and Index Scala**를 실행합니다. `.scala` 편집기의 **Go to Definition**은 컴파일러가 해석한 심볼을 사용하므로 하위 프로젝트 간 오버로드도 올바른 선언으로 이동합니다. 소스나 빌드가 바뀌면 다시 컴파일합니다.

### Kotlin Multiplatform

**Inspect Kotlin Multiplatform Targets**에서 Gradle이 구성한 JVM·JavaScript 타깃과 소스셋 의존 관계를 확인합니다. **Compile Kotlin Multiplatform Targets**, **Test Kotlin Multiplatform Targets**, **Run Kotlin Multiplatform Target**은 관찰된 타깃의 컴파일·테스트·실행 작업을 사용합니다. JavaScript 실행과 테스트는 Node.js 타깃을 대상으로 합니다.

Windows에서 한글 프로젝트 경로의 JVM 테스트가 Gradle 작업자를 시작하지 못하면 `rocketbrain.kotlin.gradleHome`에 Gradle 9.7.0 설치 경로를 지정합니다. 이 설정은 Kotlin Multiplatform 작업에 적용됩니다.

컴파일 뒤 편집기의 **Go to Definition** 또는 **Open Kotlin Expect or Actual Declaration**에서 최상위 함수와 프로퍼티의 단순 스칼라 시그니처를 연결합니다. 공통 `expect`에서 플랫폼별 `actual`을 선택하거나 `actual`에서 원래 선언으로 돌아갈 수 있습니다. 소스나 빌드 구성이 바뀌면 다시 컴파일합니다.

### SSH 원격 파일

사용자 설정 `rocketbrain.sshWorkspace.profiles`에 SSH 서버, 사용자, 원격 루트와 검증된 로컬 `known_hosts` 파일을 등록합니다. 로컬 OpenSSH와 원격 Python 3.8 이상이 필요합니다. 키 파일을 지정하거나 OpenSSH 에이전트에 등록한 키를 사용할 수 있습니다.

**Open SSH Workspace**로 연결하면 **SSH Workspace** 트리에서 일반 파일과 디렉터리를 탐색하고 원격 파일을 편집기에서 읽을 수 있습니다. 기존 텍스트 파일을 교체하려면 파일의 **Review Local File Upload to SSH**에서 로컬 파일을 선택하고 VS Code 차이를 검토합니다. 검토 이후 원격 파일이나 로컬 파일이 바뀌면 다시 검토합니다. 파일 읽기와 교체는 2 MiB까지 지원합니다.

### Kotlin JVM 편집

[MIT 라이선스의 standalone ktlsp 1.4.0-rc1](https://codeberg.org/winlogon/ktlsp/releases/tag/v1.4.0-rc1)을 압축 해제한 `server` 디렉터리를 `rocketbrain.kotlinEditor.serverHome`에 지정합니다. 독립 JDK 21 이상과 Gradle 프로젝트를 사용합니다. 로컬 `.kt` 파일을 열면 값과 멤버 자동 완성, 타입 표시, 선언 이동 및 컴파일 진단을 사용할 수 있습니다. **Stop Kotlin Language Support**로 세션을 종료하고 **Show Kotlin Language Server Output**에서 서버 출력을 확인합니다.

검증한 릴리스 ZIP의 SHA-256은 `27d33f2879d12076174741488721896098e8494f5d906f99ef1c85d6159d42b7`입니다. Windows에서는 Unicode 프로젝트 경로의 진단을 위해 임시 호환 JAR를 생성합니다. 실행 전 서버와 컴파일러 JAR의 SHA-256을 확인합니다.

### 로컬 ACP 에이전트 비교

사용자 설정 `rocketbrain.acp.agents`에 신뢰하는 ACP v1 실행 파일과 인수를 등록합니다. **Compare Local ACP Agent Replies**로 두 개 또는 세 개를 선택한 뒤 동일한 요청을 보냅니다. 각 프로그램은 선택한 작업 폴더와 현재 사용자의 OS 권한으로 실행됩니다. 에디터는 ACP 파일·터미널 요청과 권한 부여를 거절합니다.

**Review Local ACP Agent Replies**는 한 응답을 텍스트로 열거나 두 응답을 VS Code 차이 보기에서 비교합니다. 실행 중에는 진행 알림에서 세션을 취소할 수 있습니다.

### Kotlin 코루틴 상태와 생성 스택

**Prepare Kotlin Coroutine Probe**에서 프로젝트와 같은 버전의 `kotlinx-coroutines-debug-1.11.0.jar`를 선택하고, 복사한 `vmArgs`로 로컬 개발 JVM을 실행합니다. 앱의 일반 JVM 클래스패스에 Kotlin 코루틴 라이브러리와 디버그 라이브러리가 있어야 합니다. 실행 후 **Kotlin Coroutines**의 **Connect Local Probe**에서 `coroutine-probe.json`을 열고 스냅샷을 새로 고칩니다.

코루틴을 펼치면 생성 스택과 마지막 관찰 스택이 표시됩니다. 실행 중인 코루틴의 마지막 관찰 스택은 재개 지점일 수 있습니다. 로컬 소스와 일치하는 스택 프레임을 선택하면 해당 줄을 엽니다. 이 기능은 가동 중인 JVM에 시작 옵션으로 연결한 개발 프로브의 스냅샷을 읽습니다.

### Java CI 품질 게이트

VSIX의 `extension/dist/java-quality-gate.js`를 추출하거나 소스의 `scripts/java-quality-gate.js`를 실행합니다. Node.js 20 이상과 Git이 있는 CI에서 대상 저장소와 기준선 커밋을 로컬로 준비합니다.

```sh
node /path/to/java-quality-gate.js --repo . --revision "$COMMIT_SHA" \
  --baseline-revision "$BASELINE_SHA" --fail-on warning --output quality.sarif
```

`--profile`로 편집기의 Java 검사 프로필과 같은 형식의 JSON 하나를 사용합니다. 기본 검사는 빈 `catch`·`finally`, 빈 `if` 문장, 중복 `import`입니다. 선택한 커밋의 추적된 Java 파일을 검사하고, 새 발견이 임계값 이상이면 SARIF를 저장한 뒤 종료 코드 `1`을 반환합니다. 통과는 `0`, 입력이나 검사 실패는 `2`입니다. `--baseline`으로 이전 Rocketbrain SARIF를 지정하면 보고서의 정책과 기록된 조상 커밋을 다시 검사합니다. `--output -`는 표준 출력으로 보냅니다.

**Open Java Quality Gate Report**에서 SARIF를 고르면 새 문제와 기존 문제를 확인할 수 있습니다. 선택한 항목은 보고서의 커밋에서 직접 읽은 Java 소스를 읽기 전용으로 열고 발견 범위를 선택합니다.

### 로컬 MCP 도구

VSIX에서 `extension/dist/ide-mcp-server.js`를 추출하고, 같은 계정의 MCP 클라이언트가 Node.js 20 이상으로 실행하게 설정합니다. VS Code의 `.vscode/mcp.json`에서는 다음 구성을 사용할 수 있습니다.

```json
{
  "servers": {
    "rocketbrain": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/ide-mcp-server.js", "--workspace", "${workspaceFolder}", "--allow-tool", "project_inventory"]
    }
  }
}
```

`--workspace`로 허용한 로컬 폴더와 `--allow-tool`에 지정한 도구가 이 프로세스의 접근 범위를 정합니다. `project_inventory`는 소스 개수와 빌드 파일의 상대 경로를 읽습니다. `java_quality`는 로컬 Git 커밋의 Java 검사 결과를 제공하고, `sql_structure`는 입력한 MySQL·MariaDB SELECT를 DB 연결 없이 분석합니다. 추가 도구마다 `--allow-tool`을 반복합니다. 서버는 표준 입출력만 사용하며 결과 수·크기와 실행 시간을 제한합니다.

### HTTP, GraphQL, WebSocket 요청과 OpenAPI

`.http` 파일에서 요청에 커서를 두고 **Send HTTP Request**를 실행합니다. `###`로 여러 요청을 구분하고, `@name = value` 또는 `rocketbrain.http.environments`에서 변수를 정의합니다. **Set HTTP Environment Secret**으로 저장한 값은 헤더나 본문에서 `{{secret.name}}`으로 참조합니다.

gRPC 호출은 `GRPC grpcs://host:443/package.Service/Method`와 작업 공간 기준 `Proto: api/service.proto` 헤더를 사용합니다. 단일 요청은 JSON 객체, 클라이언트 스트림은 객체 배열을 입력합니다. 단항, 서버 스트림, 클라이언트 스트림, 양방향 스트림의 결과를 출력 창에서 확인할 수 있습니다. 현재는 자체 포함 `.proto` 파일을 사용합니다.

**Review WebDAV Deployment**는 `rocketbrain.deploy.webdav`에 정의한 로컬·원격 폴더와 제외 패턴을 사용합니다. **Set WebDAV Password**로 필요한 비밀번호를 저장하고, 파일을 선택해 diff를 검토합니다. **Upload Reviewed WebDAV Files**는 비교한 ETag를 조건으로 전송하고 원격 파일이 바뀌면 충돌을 표시합니다. 기존 원격 폴더의 새 파일과 변경 파일을 업로드할 수 있습니다.

```http
@host = http://127.0.0.1:8080
# @expect status 200
# @expect json $.status == "UP"
GET {{host}}/actuator/health
```

응답 상태, 헤더, JSON 경로의 예상값을 확인합니다. **Inspect OpenAPI JSON**은 OpenAPI 3.0·3.1 문서의 작업과 로컬 참조를 살핍니다. **Create HTTP Request from OpenAPI JSON**으로 편집할 요청 초안을 만들고, 환경과 필요한 매개변수를 채운 뒤 실행합니다.

`GRAPHQL` 본문은 GraphQL 문서나 `query`, `variables`, `operationName`을 담은 JSON입니다. **Send HTTP Request**로 실행하면 HTTP 상태와 GraphQL 오류 수를 확인할 수 있습니다. **Inspect GraphQL Endpoint Schema**는 선택한 엔드포인트에서 인트로스펙션을 요청합니다.

```http
GRAPHQL http://127.0.0.1:8080/graphql

query { books { title } }

### WebSocket
WEBSOCKET ws://127.0.0.1:8080/events
Sec-WebSocket-Protocol: example.events
```

`WEBSOCKET` 요청을 실행해 연결을 열고 **Send WebSocket Message**로 텍스트를 보냅니다. **View WebSocket Transcript**에서 수신 텍스트, 바이너리 바이트 수, 연결 상태를 확인하고 **Close WebSocket Connection**으로 종료합니다. 연결과 메시지 이력은 확장 실행 중에만 메모리에 보관됩니다.

기존 독립 런타임을 사용할 때는 `rocketbrain.java.javaHome`, `rocketbrain.java.serverPath`, 필요한 디버그 번들을 설정합니다. 서버용 JDK와 프로젝트용 JDK는 별개이며 프로젝트 JDK는 `rocketbrain.java.projectJdks`로 선택합니다. 원본 IDE의 내장 JBR은 거부합니다.

Java 프로젝트 가져오기와 빌드는 프로젝트 코드를 실행할 수 있습니다. 신뢰한 프로젝트만 열고, 명시적인 동기화·빌드·실행·생성/의존성 적용 단계의 안내를 확인하세요. 최초 가져오기와 일반 Java 소스 자동 빌드도 신뢰한 작업 공간에서 수행됩니다. DB 연결 환경 값과 저장한 실행 환경 값은 Secret Storage를 사용합니다.

### Java 중단점

- Java 메서드 선언 또는 호출 이름에 커서를 두고 **Add Java Method Breakpoint**를 실행합니다. JDT가 선택한 오버로드나 상속 메서드의 실제 선언에 중단점을 추가합니다. 작업 공간의 저장된 소스에서 각 메서드 선언을 별도 줄에 둡니다.
- 디버그 세션에서 일반 중단점을 검증한 줄에 커서를 두고 **Add Java Inline Breakpoints**를 실행합니다. 디버거가 반환한 위치 중 멈출 람다를 선택합니다.
- 멈춘 세션의 **변수**에서 객체의 필드를 펼칩니다. 필드 메뉴에서 읽기, 쓰기 또는 읽기·쓰기에 중단점을 설정합니다.

### Java 라이브러리 소스

Java 코드의 라이브러리 기호에서 정의로 이동하면 JDT가 원본 소스 또는 디컴파일된 읽기 전용 문서를 엽니다. **Manage Java Library Sources**에서 해당 바이너리 버전과 맞는 로컬 UTF-8 소스 JAR·ZIP을 확인하고 연결하거나 해제할 수 있습니다. 연결은 JDT에서 변경을 허용하는 프로젝트 클래스 경로에 적용되며, 소스 아카이브는 표준 패키지 경로의 `.java` 파일을 포함해야 합니다. 지원하는 클래스의 디컴파일된 줄에서 중단점을 사용할 수 있습니다. `rocketbrain.java.debugDecompiledSources`를 끄면 다음 Java 디버그 세션에서 이 줄 매핑을 사용하지 않습니다.

### Java 어노테이션 처리와 Lombok

Maven에서 `maven-compiler-plugin`의 `annotationProcessorPaths`에 프로세서를 선언하고, 편집 중에도 처리하려면 `m2e.apt.activation`을 `jdt_apt`로 설정합니다. Gradle에서는 `annotationProcessor` 의존성을 선언하고 사용자 설정 `rocketbrain.java.annotationProcessing.gradleEnabled`를 켜면 가져올 때 JDT가 해당 프로세서 구성을 동기화합니다. 이미 프로젝트가 관리하는 Eclipse APT 설정은 프로젝트 파일에서 관리합니다.

신뢰한 작업 공간에서 **Rocketbrain: Configure Java Null Checks**를 실행해 프로젝트에 있는 JSpecify, Eclipse, Spring, JetBrains 또는 사용자 정의 애너테이션을 선택할 수 있습니다. 설정은 `rocketbrain.java.nullChecks`에 저장되고, 가져온 Java 프로젝트에서 해당 애너테이션을 찾으면 JDT가 Problems 패널에 null 진단을 표시합니다. JDT는 선택한 검사 설정을 Eclipse 프로젝트 환경 설정에도 반영할 수 있습니다. 닫히지 않은 리소스는 JDT의 컴파일러 진단으로 확인할 수 있습니다. Kotlin Gradle 프로젝트의 nullable 호출은 독립 Kotlin 언어 서버가 진단합니다.

Lombok이 생성하는 멤버를 편집기에서 사용하려면 사용자 설정 `rocketbrain.java.annotationProcessing.lombokJar`에 [공식 Lombok 1.18.48 JAR](https://repo.maven.apache.org/maven2/org/projectlombok/lombok/1.18.48/lombok-1.18.48.jar)의 절대 경로를 지정합니다. 신뢰한 작업 공간에서 확장이 SHA-256을 확인하고 별도 JDT 저장소에 준비합니다. 빌드에서도 Lombok 버전과 프로세서 의존성을 선언합니다. Lombok getter를 MapStruct에서 참조하는 예제는 `lombok-mapstruct-binding`을 함께 사용합니다.

### TestNG 호출 선택과 재시도

**Open Java Test Run History**에서 작업 공간 기록을 켜면 완료한 실행의 요약과 실패 비교를 다시 열 수 있습니다. 현재 발견된 테스트와 일치하는 실패만 저장된 ID로 다시 실행합니다. [Java 테스트 실행 기록](docs/java-test-history.md)

TestNG 데이터 공급자의 동일한 스칼라 값도 관찰된 행 위치로 구분해 테스트 탐색기에서 다시 실행할 수 있습니다. 재시도가 있는 호출은 하나의 테스트로 표시되며, 다시 실행할 때는 첫 시도부터 현재 재시도 정책을 따릅니다. [TestNG 호출 선택](docs/testng-invocations.md)

## 검토하는 Java 리팩터링

Java 선언을 선택하고 명령 팔레트를 사용합니다. 변경 전후와 파일 작업을 검토한 뒤 적용합니다. 텍스트 편집과 클래스 이동에는 VS Code Undo를 사용합니다. Safe Delete로 지운 파일은 **Restore Deleted Java File**에서 복원합니다. 검토 뒤 원본·참조·리소스가 바뀌면 다시 검토해야 합니다.

**Go to Code Target**으로 Java 선언·타입·구현·상위 메서드로 이동합니다. 대상이 여러 개면 파일과 줄을 골라 열 수 있습니다. Kotlin 엔진을 구성한 Gradle 프로젝트에서는 수신 객체 타입에 맞는 확장 함수 선언으로 이동합니다. [코드 탐색](docs/java-symbol-navigation.md)

**Find JVM & Spring Usages**는 현재 파일, 해당 워크스페이스 폴더 또는 전체 워크스페이스에서 사용처를 찾습니다. Java와 Kotlin의 의미 기반 참조, Spring XML의 Bean 클래스, 정적 설정 플레이스홀더를 골라 정확한 소스 위치로 이동합니다. [사용처 검색 범위](docs/java-symbol-navigation.md#find-usages)

**File Structure**로 현재 Java·Kotlin 파일의 타입, 함수, 필드를 검색하고 중첩 선언이나 원하는 오버로드로 이동합니다. 가져온 Java 프로젝트에서는 상속 멤버와 익명·지역 타입도 확인할 수 있습니다. VS Code Outline에도 소스 위치 검사를 적용합니다. [파일 구조 탐색](docs/java-symbol-navigation.md#file-structure)

Java·Kotlin의 **Format Document**와 **Format Selection**은 상위 폴더와 현재 폴더의 `.editorconfig`를 적용합니다. **Preview Java Formatting**과 **Preview Kotlin Formatting**으로 변경 내용을 검토할 수 있습니다. Kotlin 포맷은 여러 줄 문자열 내용을 보존하며, LF·CRLF 변환은 문서 전체에 적용합니다. [Java·Kotlin 포맷 설정](docs/java-formatting.md)

**Extract Java Local Variable**, **Extract Java Field**, **Extract Java Constant**에서 새 이름과 변경 내용을 먼저 검토할 수 있습니다. 지역 변수와 필드는 `return` 식 전체 또는 지역 변수의 초기화 식을 선택합니다. 필드를 추출하면 현재 메서드에서 값을 계산해 `private` 필드에 대입합니다. 상수 추출은 컴파일 타임 상수식을 `private static final` 필드로 옮깁니다. [Java 변수·필드·상수 추출](docs/java-extract-constant.md)

**Inline Java Method Call**은 선택한 Java 호출을 메서드 본문 식으로 바꿉니다. 인자는 호출 순서대로 한 번씩 계산하며 적용 전에 변경 내용을 검토할 수 있습니다. [Java 메서드 호출 인라인](docs/java-inline-method.md)

| 명령 | 지원 범위 | 추가 분석이 필요한 범위 |
|---|---|---|
| **Move Java Class File / Move Java Class Across Projects** | 같은 소스 루트의 클래스 이동. Gradle 복합 조건과 Maven 리액터의 부모·중첩 BOM·속성 프로필을 분석한다. 기본 로컬 Maven 저장소의 외부 부모·BOM도 좌표와 SHA-256을 검증해 가시성 계산에 포함한다 | 사용자 지정 저장소 배치, 원격 확인, SNAPSHOT·복합 외부 POM, 전이 의존성 중재, 의존 관계 자동 변경 |
| **Move Java Static Member** | 일반 클래스의 public static 순수 반환 메서드·리터럴 상수 필드를 기존 Gradle 의존성의 대상으로 이동 | 인스턴스·상태를 가진 멤버, 오버로드·상속·어노테이션·임의 외부 사용 |
| **Move Java Instance Method** | 포착한 참조를 명시적으로 전달한다. 검토한 private 가변 필드를 갱신하는 여러 호출자와 불리언 매개변수의 `if`·`else` 경로를 보존한다 | 순환·외부 객체 그래프, 계산·중첩 분기, 외부 작성자, 소유권 이전, 모호한 생성자와 상속·오버로드 |
| **Move Java Package** | 리소스의 바이트와 서비스 등록 순서를 보존한다. 검토한 클래스 경로 등록과 단일 JPMS 모듈의 서비스 소비·제공 선언을 함께 이동하고, 제한된 정적 서비스 팩터리를 확인한다 | 다중·외부 모듈의 서비스 계약, 동적·사용자 정의 로더, 복합 팩터리, 복잡한 메타데이터와 새 대상 폴더 생성 |
| **Change Java Signature** | 인자 순서·리터럴 기본값 추가·미사용 인자 제거. 소스 상속·오버로드, 제한된 제네릭 타입 치환·공변 반환형·메서드 타입 변수·경계·와일드카드를 변경 전후 컴파일러로 검사 | 이름·기존 타입·반환형·접근성·예외 변경, 임의 제네릭·가변 인자·외부 바이너리·메서드 참조·framework 계약 |
| **Safe Delete Java Declaration** | 미사용 private 보조 메서드와 제한된 클래스 삭제. Spring Bean·주입·설정·XML·JPA 참조와 검토한 조건을 분석한다. 소스 합성 어노테이션의 메타 조건과 확인 가능한 `@AliasFor`도 따라간다 | 임의 조건·호출·효과·루프, 바이트코드 전용 합성 어노테이션과 불명확한 별칭 계약 |
| **Restore Deleted Java File** | Safe Delete가 확인한 원본 바이트를 덮어쓰기 없이 복원 | 최근 최대 10건을 같은 실행 세션에서 1시간 동안 제공하며, 대상 파일이 새로 생겼거나 상위 폴더가 바뀌면 거부 |

Change Signature의 첫 화면에서는 매개변수 목록을 편집합니다. 기존 인자의 이름·타입은 유지하며 새 인자에는 명시적인 리터럴 기본값이 필요합니다. 평가 순서에 영향을 줄 수 있는 복잡한 호출식과 확인된 문자열·리소스 참조는 거부합니다. 이 기능들은 검토한 프로젝트 범위에 한정되며 임의 리플렉션과 외부 사용자의 계약까지 자동 증명하지 않습니다.

외부 Maven 모델을 사용하는 리액터는 루트의 `.rocketbrain-maven-models.json`에 `version`을 `1`로 설정하고, `models` 배열에 각 모델의 `groupId`, `artifactId`, `version`, `sha256`을 기록합니다. 외부 부모에는 `<relativePath/>`를 사용합니다. 검토 범위는 기본 로컬 Maven 저장소에 설치한 릴리스 POM과 원격 출처 추적이 없는 기존 로컬 POM입니다. 미리보기 뒤 핀·모델·출처 기록이 바뀌면 적용을 중단합니다. [핀 파일 예제](test/fixtures/refactoring-v27-maven/.rocketbrain-maven-models.json)

상속·오버로드 분석과 새 이동 검사는 별도 JDK 컴파일러로 파싱·타입 연결을 검사합니다. 프로젝트 클래스·어노테이션 처리기·컴파일러 플러그인을 분석 목적으로 실행하지 않습니다. 지원하지 않는 확장이나 불완전한 클래스 경로는 거부합니다.

기존 메서드·지역 변수·필드 추출, 지역 변수 인라인과 import 정리는 **Refactor Java Selection with Preview**에서 계속 사용할 수 있습니다.

## DB 사용

SQL 편집기에서 **Ctrl+K Ctrl+Shift+J**(macOS **Cmd+K Cmd+Shift+J**) 또는 **Focus Query Results**로 결과 탭에 포커스를 옮깁니다. 좌우 방향키와 Home/End로 탭을 찾고 Enter 또는 Space로 선택합니다. 결과에서 같은 단축키 또는 **Focus Query Editor**로 원래 열린 SQL 편집기에 돌아갑니다. Ctrl+Enter(macOS Cmd+Enter)는 SQL, JPQL, 연결된 DuckDB·JDBC의 언어별 실행 명령을 사용합니다.

**Sort and Filter**에서 JSON 열의 경로와 값 종류를 지정해 서버에서 정렬합니다. JSON 정수는 서버가 관찰한 20자리 이내 정수, 텍스트는 256바이트 이내 UTF-8 바이트 순서, 불리언은 false/true 순서입니다. 누락·JSON NULL·타입 불일치·길이 초과는 SQL NULL 그룹으로 정렬합니다. InnoDB 읽기 스냅샷에서도 NULL 위치, 서버에서 확인한 텍스트 collation, 기본 키 동률 해소를 적용해 전후 페이지와 연속 스크롤을 탐색합니다.

MySQL/MariaDB 연결 편집기의 **Write protection**에서 연결 전체를 읽기 전용으로 잠그거나 보호할 `schema.table`을 줄마다 지정합니다. 보호 설정을 바꾸려면 해당 프로필의 연결을 끊고 다시 연결합니다. 보호된 테이블의 결과 그리드는 조회용으로 열립니다. 테이블 보호가 설정된 프로필에서 테이블과 뷰를 조회하는 SQL은 읽기 전용 콘솔에서 실행합니다. 쓰기는 대상 InnoDB 테이블 하나의 트리거와 연쇄 변경 위험을 확인한 경우에 허용됩니다. 저장 함수의 실행 권한과 외부 클라이언트의 쓰기에는 서버 계정과 트랜잭션 권한이 적용됩니다.

보호 설정이 적용된 쓰기는 같은 InnoDB 트랜잭션에서 대상 테이블과 보호 테이블로 연쇄 변경을 전달할 수 있는 의존성의 메타데이터 잠금을 유지합니다. 자동 커밋 모드에서 쓰기 검증을 위해 자동으로 시작한 트랜잭션은 쓰기마다 끝납니다. 사용자가 시작한 트랜잭션과 수동 커밋 모드에서는 **Commit** 또는 **Roll Back**까지 잠금이 유지됩니다.

**Save SQL Parameter Preset**은 선택한 SQL의 typed parameter 값을 VS Code Secret Storage에 저장합니다. SQL 실행에서 저장값을 선택하면 연결과 서버 계정, SQL 원문, 파라미터 정의와 관찰한 열 타입이 일치하는지 확인하고 실행 전에 검토를 받습니다. 단일 테이블의 열과 파라미터를 비교하는 SELECT와 열을 명시한 INSERT에는 확인한 열 타입을 제안합니다. **Remove SQL Parameter Preset**에서 저장값을 삭제할 수 있습니다.

**Database Connections**에서 MySQL/MariaDB 프로필을 만들고 연결을 검증합니다. 여러 저장 프로필 중 하나가 활성 연결입니다. SQL 콘솔에서 문장·선택 구간을 실행하고, 결과 그리드의 수정·추가·삭제를 검토한 뒤 트랜잭션을 적용하거나 되돌립니다.

**Duplicate Database Profile**은 기존 연결 설정을 새 이름으로 복사해 편집기를 엽니다. 복사본에는 새 프로필 ID가 부여되며 비밀번호가 필요한 연결은 별도로 입력합니다. 공유 파일을 가져올 때 같은 그룹에 이름이 겹치면 이름을 바꿔 가져오거나 해당 항목을 건너뜁니다.

연결의 **Session lifecycle**에서 물리 연결마다 적용할 `SET SESSION` 초기 SQL을 지정합니다. 시간대·선택 SQL 엄격 모드·`sql_safe_updates`·`group_concat_max_len`을 지원합니다. Keep-alive는 유휴 세션의 상태를 읽습니다. Idle timeout은 실행 중인 문장과 트랜잭션이 없는 자동 커밋 세션을 종료합니다. **Reconnect Console Session**으로 새 연결을 열면 초기값을 다시 적용합니다.

**Open SQL Console**은 읽기 전용 전용 세션을 엽니다. 기존 SQL 편집기에서 **Open Shared SQL Console**을 실행하면 같은 서버 연결과 트랜잭션을 사용하는 새 편집기가 열립니다. 두 편집기에서 쓰기 모드, 커밋과 롤백이 공유됩니다. 편집기를 닫아도 트랜잭션은 남습니다. **Manage Console Sessions**에서 연결된 편집기 수를 확인하고 공유 세션을 한 번에 종료합니다.

연결 트리에서 **Open Dedicated Profile SQL Console**을 선택하면 활성 카탈로그를 바꾸지 않고 선택한 프로필로 SQL을 실행할 수 있습니다. 전용 편집기에는 대상 프로필과 스키마가 표시됩니다. 읽기 전용으로 시작하며, 쿼리 실행·쓰기 모드·커밋·롤백·세션 격리를 제공합니다. 연결 그룹의 색상과 세션 상태로 여러 서버를 구분합니다. 세션 트리에서 SQL 편집기를 다시 열거나 해당 프로필 카탈로그를 읽기 전용으로 확인합니다. 미해결 거래나 공유 편집기가 있는 세션은 영향을 확인한 뒤 닫을 수 있습니다. 공유 스키마 편집·검토 스크립트·EXPLAIN은 활성 카탈로그를 사용합니다.

**Track SQL Console as Draft**로 보관을 시작하면 편집 중인 SQL과 선택 영역이 로컬에 갱신됩니다. 닫거나 재시작한 뒤 **Restore SQL Draft**에서 오프라인으로 이어서 편집합니다. [SQL 콘솔 초안 복원](docs/sql-draft-recovery.md)

- **Open Local DuckDB Read-Only**에서 로컬 `.duckdb` 파일과 별도 설치한 DuckDB CLI 1.5.6 이상을 선택합니다. **New DuckDB Query**로 전용 SQL 편집기를 열고, **Run Read-Only DuckDB Query**로 단일 읽기 쿼리를 실행합니다. 테이블·뷰의 열과 타입, 네이티브 함수의 오버로드는 **Browse DuckDB Tables and Views**와 **Find DuckDB Functions**에서 확인합니다. **Preview Local CSV or Parquet with DuckDB**는 직접 선택한 파일 하나의 열 타입과 행 표본을 별도 읽기 작업으로 표시합니다. 일반 쿼리의 외부 파일 접근과 쓰기는 차단합니다. **Inspect DuckDB Extensions**는 현재 바이너리의 설치·로드 상태와 버전을 보여 줍니다.
- **Manage Workspace DuckDB Extension**에서 공식 `tpch`·`tpcds` 확장의 설치·업데이트·사용·제거를 관리합니다. 다운받은 파일은 DuckDB로 서명과 실행 호환성을 확인한 뒤 워크스페이스 전용 저장소에 둡니다. 활성화한 확장은 현재 DB 접속에 적용되며, 사용자 SQL의 외부 파일 접근 차단은 유지합니다.
- **Add JDBC Driver**에서 별도 JDK와 공급사 JAR를 사용합니다. 드라이버 클래스와 SHA-256을 검토해 승인하고, **Manage JDBC Profiles**로 연결한 뒤 카탈로그와 읽기 쿼리를 사용할 수 있습니다. [사용자 지정 JDBC 드라이버 문서](docs/jdbc-drivers.md)
- 연결 프로필에는 TCP, Unix 도메인 소켓, Windows 명명된 파이프 중 실행 환경과 맞는 전송을 선택합니다. 공유 프로필에는 비밀번호와 로컬 경로를 담지 않으며, 가져온 로컬 연결의 주소는 해당 컴퓨터에서 입력합니다.
- **Save Database Metadata for Offline Use**로 카탈로그의 테이블·뷰와 열을 작업 공간에 저장합니다. 연결을 끊고 **Open Cached Database Metadata**를 선택하면 캡처 시각과 함께 SQL 완성에 사용합니다. 같은 연결로 돌아오면 현재 구조를 확인하고 바뀐 캡처를 무효화합니다.
- **New Federated SELECT**에서 `source1`과 `source2`의 테이블을 참조하고 **Run Federated SELECT**에서 저장한 연결을 하나씩 선택합니다. 정수 키의 INNER 또는 LEFT JOIN을 지원합니다. 결과에서 출처별 투영 열, 서버에 전송한 필터와 가져온 행 수를 볼 수 있습니다. 각 서버는 별도의 읽기 시점을 사용합니다.
- **Set SQL Session Isolation**은 열린 SQL 콘솔의 연결에 격리 수준을 적용하고 서버 값을 다시 확인합니다. 트랜잭션과 검토 중인 그리드 초안이 있으면 먼저 정리해야 합니다.
- **Save SQL Query**는 현재 선택 구간이나 문서를 작업 공간에 저장합니다. **Saved SQL Queries**에서 태그나 즐겨찾기로 검색하고, 현재 연결 또는 바인딩한 저장 프로필에서 읽기 전용으로 실행합니다.
- **Query History**를 켜면 사용자가 편집기에서 직접 실행해 성공한 읽기 전용 쿼리를 기록합니다. 30일 범위에서 검색·삭제하고 원래 연결의 새 콘솔로 재실행할 수 있습니다.
- **Format SQL**은 현재 문서나 선택한 SQL에서 절의 줄 배치와 들여쓰기를 정리합니다. **Insert SQL Template**은 활성 카탈로그의 테이블·열을 넣으며, 알 수 없는 이름과 모호한 열에는 확인한 빠른 수정을 제공합니다.
- 비어 있는 SQL 절에서 카탈로그 기준 필드 목록을 완성합니다. SELECT에는 현재 범위의 열, INSERT에는 자동 생성 열을 제외한 쓰기 열, GROUP BY에는 SELECT에서 확인한 직접 참조 열을 제안합니다.
- 편집기는 바깥쪽 `WHERE`가 없는 `UPDATE`와 `DELETE`를 표시합니다. 쓰기 콘솔과 스크립트 실행은 이 문장이 대상 행 전체에 미칠 수 있는 영향을 검토하고 승인한 뒤 진행합니다.
- 활성 MySQL/MariaDB 연결의 SQL 편집기에서 두 실테이블을 지정한 `JOIN`의 대상이나 비어 있는 `ON`에 커서를 놓습니다. **Complete JOIN using …** 빠른 수정은 실제 FK의 모든 열을 순서대로 삽입합니다. 선택 뒤 소스나 관계가 바뀌면 다시 선택합니다.
- 활성 스키마의 SELECT에서 해석되지 않는 테이블명이나 대상이 분명한 누락 열에 커서를 놓습니다. **Design Unresolved Table** 또는 **Design Column**에서 확인된 이름으로 테이블 디자이너를 엽니다. 열을 추가할 때는 필요한 타입을 지정합니다. 실제 스키마는 SQL 검토와 적용을 거쳐서 변경합니다.
- **Review SQL Script**는 독립된 `DELIMITER` 줄 사이에 있는 `CREATE PROCEDURE`, `CREATE FUNCTION`, `CREATE TRIGGER`의 `BEGIN … END` 블록을 한 문장으로 검토합니다. 실행은 쓰기 콘솔에서 DDL의 암시적 커밋을 승인한 뒤 진행합니다. `DELIMITER ;`로 돌아오면 일반 문장에 바인딩 값을 사용할 수 있습니다. 저장 프로그램 본문의 동적 SQL, 세션 제어와 매개변수 바인딩은 지원 범위 밖입니다.
- **Run SQL Script**에서 유휴 자동 커밋 콘솔에 하나의 `BEGIN … COMMIT` 또는 `BEGIN … ROLLBACK` 블록을 검토해 실행할 수 있습니다. 같은 스키마의 InnoDB 기본 테이블, 직접 행 변경, 단일 테이블 열 조회와 이름이 지정된 세이브포인트를 지원합니다. 쓰기 커밋은 별도 승인을 받습니다. 문장이 실패하거나 실행이 멈추면 확장이 시작한 트랜잭션의 롤백을 확인하고, 응답을 잃으면 결과를 미확정으로 표시합니다.
- 읽기 전용 스크립트에서 검토한 프로시저의 IN과 INOUT 초기값을 타입으로 바인딩합니다. OUT 자리에는 `@output` 형식의 영문 이름을 입력합니다. OUT 이름은 캡처한 출력 그리드의 표시 이름이며 이후 SQL의 세션 변수에 값을 넣지 않습니다. 읽기와 출력 매개변수 대입만 하는 프로시저를 대상으로 하며 결과를 다시 열 때 호출을 반복하지 않습니다.
- 읽기 전용 스크립트에서는 현재 스키마의 검증된 `CALL procedure(:input)`을 다른 조회와 함께 실행합니다. 보이는 프로시저의 본문과 IN 매개변수를 다시 확인합니다. 지원 범위는 같은 스키마의 기본 테이블을 읽는 단순 `SELECT`입니다. 스크립트 결과에서 각 결과 집합을 다시 열 수 있습니다.
- `DELIMITER`가 있는 SQL 파일에서 **Run Selected SQL or Current Statement**를 실행하면 서버의 SQL 모드로 커서 아래 문장이나 선택한 전체 복합 문장의 범위를 구합니다. 복합 DDL 검토에는 그 문장 하나가 표시됩니다.
- SQL 편집기는 단일 테이블 INSERT 열 목록, UPDATE의 SET, UPDATE·DELETE의 WHERE에서 관찰한 열 이름과 서버 타입을 제안합니다. 스키마를 명시하면 그 테이블을 확인합니다. 자동 증가·생성 열은 쓰기 제안에서 제외합니다.
- **Find SQL Catalog References**는 열 목록이 있는 `INSERT … SELECT`의 입력과 대상, 실제 테이블을 조인한 UPDATE의 SET과 읽기 표현식, 여러 별칭을 대상으로 한 DELETE를 구분합니다. 사용처를 찾을 때 원래 쓰기 문장은 실행하지 않습니다.
- **Preview SQL with a Virtual Schema**는 로컬 UTF-8 DDL 파일 또는 관찰한 DB 카탈로그를 바탕으로 현재 SQL 문서의 테이블·뷰와 열 변경을 순서대로 분석합니다. 편집기의 완성·진단에만 반영합니다. 파일을 수정한 뒤에는 다시 선택해 캡처하고, **Exit Virtual SQL Schema Preview**로 종료합니다.
- **Refresh SQL Collation Checks**를 실행하면 연결된 서버의 콜레이션과 문자 집합을 읽어 SQL 편집기에 표시합니다. 확인된 열, 명시적 문자 집합 리터럴과 문자형 CAST에 적용할 수 없는 콜레이션, 관찰되지 않은 이름, 비교식의 충돌하는 명시적 콜레이션을 해당 위치에 표시합니다. 연결이 바뀌면 다시 새로 고칩니다.
- **Manage Saved Virtual Schemas**는 선택한 ALTER TABLE … ADD COLUMN과 CREATE VIEW … AS SELECT 정의를 현재 연결과 스키마의 로컬 작업공간에 저장합니다. 다른 SQL 편집기에서 저장한 모델을 적용하면 가상 열과 뷰의 타입을 완성과 진단에서 볼 수 있습니다. 지원하는 생성 열은 부호 있는 정수·고정소수점 열의 산술식이며, 교차 스키마 뷰 입력은 현재 계정으로 확인할 수 있는 이름과 열을 사용합니다. 저장된 모델이나 카탈로그가 바뀌면 다시 적용합니다. 적용한 편집기에서 SQL을 실행하려면 **Exit Virtual SQL Schema Preview**를 선택합니다.
- **Edit Embedded SQL or JSON**은 Java 문자열·텍스트 블록, MyBatis의 정적 SQL 또는 SQL 안의 JSON을 해당 언어 편집기로 엽니다. SQL 편집에서는 연결한 DB의 열 완성과 정의 이동을 사용할 수 있습니다. **Review and Apply Embedded Source Edit**에서 원본 범위의 diff를 확인하고 적용합니다.
- **Create Native Database Dump**와 **Review and Restore Native Dump**에서 설치한 MySQL 또는 MariaDB 클라이언트를 선택합니다. 로컬 연결의 InnoDB 테이블을 내보내고, 검토한 백업 파일을 원본과 다른 빈 스키마에 복원합니다. 함께 참조하는 FK 테이블은 같은 백업에 포함합니다.
- `rocketbrain.sql.analysis.resolutionScopes`에서 `source`에 작업 공간 내 파일 또는 `queries/` 같은 폴더를 지정하고, `ddl`의 상대 경로와 `database`, `dialect`를 설정할 수 있습니다. 더 구체적인 경로가 우선하며 로컬 카탈로그를 읽을 수 없으면 진단을 표시합니다.
- **Visualize SQL Execution Plan**은 선택한 읽기 쿼리의 계획을 트리와 표, 서버 원본 JSON으로 표시합니다. MySQL은 서버의 TREE 원문도 표시합니다. 서버에서 반환한 행 추정치와 비용을 보존합니다.
- **Measure SQL Execution Plan**은 승인한 읽기 쿼리를 별도 읽기 전용 세션으로 실행해 서버가 보고한 행, 반복 횟수, 시간을 표시합니다. **Compare Captured SQL Plans**는 같은 연결과 캡처 모드의 열린 계획을 나란히 보여줍니다.
- **Measure SQL Plan Series**는 승인한 쿼리를 2~5회 순차 실행해 관찰된 행·반복·시간의 최솟값·중앙값·최댓값과 원본 표본을 표시합니다. 계획과 시리즈 비교는 양쪽에서 고유하게 대응하는 연산자가 이동하면 이전과 현재의 트리 위치를 함께 표시합니다.
- **Export SQL Plan Samples**는 열린 시리즈의 원본 서버 출력, 표본별 계획 형태, 정확한 통계 요약을 새 로컬 JSON 파일에 저장합니다. 원본 서버 출력에는 쿼리의 리터럴 값이 포함될 수 있습니다.
- **Open Saved SQL Plan Samples**에서 저장한 시리즈를 다시 열어 원본 표본을 확인하고 비교할 수 있습니다. SQL을 실행하지 않고 원문에서 통계를 재구성합니다. 조건이나 인덱스가 바뀐 경우 양쪽에서 고유한 접근 이름과 방식으로 이동 후보를 표시합니다.
- 계획 비교에서 한 연산자에 가능한 대응이 여러 개면 후보의 위치와 접근 근거를 볼 수 있습니다. 비교 화면에서 대응을 선택하거나 제외하고 초기화할 수 있습니다.
- 계획 비교의 **Save review**와 **Load review**는 결정과 두 캡처를 확인하는 정보를 JSON에 저장하고 다시 적용합니다. 작성한 VS Code 프로필에서 저장한 두 측정 시리즈를 같은 순서로 열면 검토를 불러올 수 있습니다.
- 다른 프로필에서는 저장한 두 측정 시리즈를 같은 순서로 열고 비교 화면의 **Review shared file**에서 받은 검토를 엽니다. 캡처와 후보가 맞으면 항목별로 승인하거나 건너뛸 수 있습니다. 승인한 결정은 받는 프로필의 비교에 함께 적용됩니다.
- **Show SQL Activity Log**에서 MySQL·MariaDB 워크벤치의 콘솔, 메타데이터, DDL, 권한 및 세션 요청을 기록합니다. **Keep history in this workspace**를 선택하면 최근 최대 400개를 다시 열 수 있습니다. 내부 메타데이터와 상태 조회는 최대 100개를 기록하고, 반복 조회가 DDL·권한 변경·콘솔 실행 기록을 밀어내지 않도록 합니다. 재시작 당시 끝나지 않은 요청은 결과 미확인으로 표시합니다. SQL 원문, 변수 값, 연결 설정과 서버 오류 텍스트는 기록에서 제외됩니다. **Browse Database Object Names**에서는 테이블·뷰 이름을 먼저 읽고 선택한 객체의 열과 인덱스를 조회합니다.
- 결과 탭에 이름을 붙이거나 고정하고, 보관된 스크립트 결과에서 각 문장의 캡처를 다시 엽니다. 테이블 필터는 중첩 AND/OR와 타입별 열 검색을 지원하며, 저장한 조건을 같은 연결·테이블에서 다시 선택할 수 있습니다.
- **Generate JPA Entity from Table**은 현재 스키마의 열과 기본 키에서 Jakarta Persistence 클래스를 만듭니다. 선택한 외래 키와 같은 프로젝트의 대상 엔티티를 대조해 `@ManyToOne` 또는 `@OneToOne`을 추가할 수 있습니다. 스칼라 필드 또는 연관 필드 중 하나를 쓰기 소유자로 지정하고, 적용 전에 카탈로그와 Java 원본을 다시 확인합니다.
- 같은 명령에서 기존 자식 엔티티의 명시적 `@ManyToOne` 필드를 확인해 역방향 `@OneToMany(mappedBy)`를 생성합니다. 두 외래 키가 기본 키를 구성하는 연결 테이블에서는 소유 측 `@ManyToMany`를 생성합니다. 검토한 새 엔티티 파일에 적용합니다.
- 새 엔티티의 기본 키를 가리키는 자기 참조 FK와 같은 MySQL·MariaDB 서버의 다른 스키마를 가리키는 FK도 매핑할 수 있습니다. 교차 스키마 대상은 실제 FK와 로컬 Jakarta 엔티티의 명시적 `@Table(catalog = …)`을 함께 확인합니다.
- **Review JPA Relationship Between Existing Entities**는 실제 단일·복합 FK를 기준으로 기존 Jakarta 엔티티의 `@ManyToOne`과 역방향 `@OneToMany(mappedBy)`를 검토합니다. 동일 서버의 교차 스키마 연결 테이블을 사용하는 양방향 `@ManyToMany`도 검토할 수 있습니다. 두 파일과 카탈로그를 다시 확인한 뒤 편집기에 함께 적용합니다. 파일 저장은 사용자가 결정합니다.
- 기존 엔티티 관계 검토에서 명시적으로 매핑한 `@EmbeddedId`와 기본 키 외 고유 키를 사용하는 FK도 물리 열과 대조합니다.
- `@EmbeddedId`의 명시적 `@AttributeOverride`와 `@AttributeOverrides`를 물리 열에 맞춰 해석합니다. 단일 PK 부모의 FK가 자식의 복합 키 중 한 멤버를 구성하면 `@MapsId("멤버")`를 검토할 수 있습니다. 자식 연관 필드가 공유 키를 쓰고, 나머지 로컬 키 열의 매핑을 유지합니다.
- **Browse Database System Catalog**에서 계정에 보이는 시스템 스키마와 객체·열 정의를 확인합니다. **Inspect Database Account Access**는 직접 부여 항목과 관찰한 역할을 표시합니다. 필요한 권한이 있는 세션에서 **Review Table SELECT Grant or Revoke**로 특정 기존 계정의 한 테이블 SELECT를 검토하고 적용합니다.
- **Inspect Database Role Inheritance**는 명시적으로 부여된 역할을 따라가며 직접·중첩 역할, 역할마다 관찰한 객체 권한, 경로 및 관리 옵션을 읽기 전용 문서로 엽니다. 연결 계정에서 볼 수 있는 메타데이터를 표시합니다. 역할 활성화, 암시적 역할, 권한 철회와 서버 정책은 실제 접근에 영향을 줍니다.
- **Review Database Role Membership**에서는 현재 계정에 직접 ADMIN OPTION이 있는 역할을 기존 로그인 계정 하나에 부여하거나 회수합니다. 선택한 역할과 계정의 정확한 식별자, 관찰한 역할 권한·상속, 변경 전후의 직접 할당을 검토합니다. 관리 옵션을 함께 부여하려면 별도 승인이 필요합니다. MariaDB에서는 역할은 유지하고 관리 옵션만 회수할 수도 있습니다. 해당 역할이 기본 역할인 계정은 기본 설정을 별도로 검토해야 합니다.
- **Review Database Account or Role Creation**에서 대상 서버, 실행 계정, 새 로그인 계정의 정확한 호스트 또는 역할을 확인하고 한 번만 적용합니다. 암호는 확정 후 마스킹 입력창에서 받으며 Rocketbrain 검토 문서나 결과에 저장하지 않습니다. MariaDB는 생성한 역할의 관리자를 실행 계정으로 지정합니다. 서버에 계정 생성 권한과 좁은 계정 카탈로그 조회 권한이 필요합니다.
- **Open Database Object Source**는 연결 계정에 보이는 스키마와 객체의 `SHOW CREATE` 원문을 읽기 전용 SQL 문서로 엽니다. DB 트리에서 바로 열거나 현재 객체의 원문을 새로 고칠 수 있습니다.
- **Go to Database Column Origin**은 SQL 편집기에서 선택한 열의 CTE·파생 테이블 별칭과 연결 계정으로 확인한 뷰 정의를 따라 원본 테이블의 열 선언을 엽니다. **Explain Database Column Origin**에서 경로와 열 타입을 확인할 수 있습니다. 원본을 찾을 수 있는 단일 열 전달을 지원하며, 계산 결과·재귀·집합 연산이나 확인할 수 없는 뷰에서 추적을 중단합니다. 일반 **Go to Definition**은 편집기 안의 별칭 정의로 계속 이동합니다.
- **Open Database Source for Editing**의 트리거 편집은 MySQL 8.4와 MariaDB 11.4에서 현재 계정이 정의한 InnoDB 테이블의 BEFORE INSERT·UPDATE 트리거를 지원합니다. NEW 열에 대한 대입과 조건문을 빈 복제 테이블에서 컴파일한 뒤, 검토한 DROP·CREATE를 테이블 쓰기 잠금 아래 실행합니다. 연결이 끊기면 두 DDL 사이에 작업이 멈출 수 있으므로 적용과 복원 중에는 쓰기와 외부 스키마 변경을 중지합니다. 저장된 원문·생성 문맥·실행 순서를 재연결 후 확인해 복원할 수 있습니다.
- **Open Database Source for Editing**에서는 기존의 결정적 `NO SQL` 스칼라 함수 중 숫자형 매개변수와 단일 `RETURN` 식을 편집할 수 있습니다. 원래 시그니처·소유자·보안·권한을 비교하고 검증용 객체를 컴파일한 뒤 실제 교체 SQL을 검토합니다. 앱 스키마의 의존 정의를 읽을 수 없거나 다른 객체의 참조·동적 SQL이 관찰되면 교체를 막습니다. `DROP`과 `CREATE` 사이에는 함수가 잠시 없어지므로 호출과 외부 스키마 변경을 중지해야 합니다. 보관된 원본은 검증된 상태에서 복원할 수 있습니다.
- **Review MariaDB Package Call**은 MariaDB 11.4 이상의 현재 DB에서 SQL/PSM과 Oracle 모드로 저장된 패키지의 명세·본문 및 공개 멤버를 찾습니다. 공개 프로시저는 스칼라 IN·OUT·INOUT을, 공개 함수는 스칼라 입력과 반환 타입을 검토하고 승인 후 전용 세션에서 한 번 실행합니다. 함수는 서버 읽기 전용 트랜잭션에서 한 값을 반환한 뒤 롤백합니다. 명세·본문 변경은 호출 전후 검사하며, 결과와 출력 매개변수는 별도 그리드에 보관합니다. 패키지 호출 시 서버가 초기화 코드를 실행할 수 있습니다. 오버로드, 기본값이 있는 매개변수와 복합 타입은 검토 대상에서 제외합니다.
- **Review Stored Procedure Call**은 현재 DB에서 정의가 보이는 독립 프로시저를 찾아 계정, 실제 정의와 `IN`·`OUT`·`INOUT` 파라미터를 검토합니다. 확인 후 별도 연결에서 한 번만 실행하며, 결과 집합과 출력 파라미터를 각각 읽기 전용 그리드로 열 수 있습니다. 최대 32개 파라미터와 결과 집합 8개까지 처리합니다. DB 권한은 서버가 적용하며, 쓰기 보호 프로필은 호출을 거부합니다. MariaDB에서는 호출 전후 정의를 비교합니다. 호출 중 다른 세션이 정의를 바꿀 수 있고, 프로시저가 직접 커밋한 변경은 돌이킬 수 없습니다.
- **New SQL Notebook**은 `.rbsql` 문서에서 Markdown과 SQL 셀을 사용합니다. **Rocketbrain SQL** 커널은 연결된 MySQL·MariaDB에서 SQL 셀마다 한 읽기 전용 문장을 실행합니다. **Pin SQL Notebook Result**로 결과를 고정하면 문서를 저장하거나 공유할 때 표시 데이터가 함께 포함됩니다.
- `JOIN` 뒤 테이블 자동 완성은 현재 스키마에서 확인된 외래 키마다 `ON` 조건을 제안합니다. 복합 외래 키의 모든 열을 선언 순서대로 포함합니다.
- SQL 표현식에서는 현재 범위의 별칭과 열을 약어로 찾을 수 있습니다. 예를 들어 `p.dn`으로 `p.display_name`을 완성합니다. 활성 MySQL·MariaDB의 버전과 SQL 모드에 맞는 내장 함수 템플릿을 삽입하고 괄호 안의 현재 인수를 표시합니다. 지원하는 구문은 [MySQL 함수 참조](https://dev.mysql.com/doc/refman/8.4/en/built-in-function-reference.html)와 [MariaDB 함수 참조](https://mariadb.com/docs/server/reference/sql-functions/function-and-operator-reference)를 따릅니다.
- 일반 SQL 편집기에서 스크립트에 선언한 열과 InnoDB 보조 인덱스의 변화를 뒤 문장의 자동 완성과 진단에 반영합니다. 열 추가·이름 변경·삭제와 단순 인덱스 추가·이름 변경·삭제를 지원합니다. 모델을 적용할 때 DB에 DDL을 보내지 않습니다. SQL 모드 변경이나 모델링 범위 밖의 문장이 나타나면 이후 문장의 이름 추론을 중단합니다. [MySQL ALTER TABLE](https://dev.mysql.com/doc/refman/8.4/en/alter-table.html), [MariaDB ALTER TABLE](https://mariadb.com/docs/server/reference/sql-statements/data-definition/alter/alter-table)
- 결과 탭은 Grid·Record·Tree·Text·Transpose 보기와 열 레이아웃을 제공합니다. Export는 캡처한 결과 페이지의 전체 열을 CSV, JSON, Excel 또는 검토용 INSERT SQL로 저장합니다.
- **Open Consistent Table Snapshot**은 기본 키가 있는 InnoDB 테이블을 별도 읽기 전용 트랜잭션에서 엽니다. 다음·이전 페이지는 정렬 값과 기본 키를 기준으로 서버에서 읽습니다. 탭을 닫으면 스냅샷 연결이 해제됩니다.
- 이 결과 그리드에서 **Continuous scroll**을 켜면 위·아래로 이동할 때 인접 페이지를 읽습니다. 최근 페이지를 최대 4개, 합계 1,000행과 4 MiB 범위로 보관하며 단일 페이지는 기존 결과 한도를 따릅니다. 복사와 내보내기는 현재 보관한 행을 사용합니다. `ENUM`은 서버 멤버 순서로, `SET`은 각 엔진의 64비트 정렬 순서로 비교하며 셀에는 원래 값이 표시됩니다.
- **Schema Catalog**에서 현재 계정이 볼 수 있는 스키마를 최대 16개 선택해 함께 탐색합니다. 선택과 숨긴 객체는 연결별로 저장됩니다. 객체를 열어 실제 서버 DDL을 볼 수 있으며 선택한 스키마는 통합 검색의 선택 항목에도 표시됩니다.
- Grid와 Record에서 같은 변경 초안을 편집하고 검토합니다. 테이블별 열 배치는 같은 연결·스키마에서 다시 열 때 복원됩니다. 읽기 전용 테이블 행의 **Related Rows**는 물리 FK의 모든 키 값을 바인딩해 별도 결과를 엽니다.
- 편집 가능한 테이블에서 **Paste Cells**의 **Continue into following server pages**를 선택하면 현재 정렬·필터 순서로 이어지는 행에 최대 500행의 CSV·TSV 값을 붙여넣습니다. 현재 페이지의 원본과 이후 행의 기본 키를 캡처하여 검토에 사용합니다. 겹치지 않는 셀의 로컬 초안을 함께 유지하며, 적용은 모든 대상의 원본 값을 다시 확인한 후 같은 트랜잭션에서 진행합니다. 여러 페이지의 검토는 현재 편집 세션에서 적용과 커밋 또는 롤백을 마칩니다.
- **Chart** 보기에서 캡처한 결과 페이지의 막대·선 그래프와 정확한 그룹 합계·평균을 확인합니다. 셀 편집기는 줄바꿈 종류, JSON 원문, Hex·Base64와 SQL NULL을 구분합니다.
- **Map** 보기에서 캡처한 결과의 공간 열을 선택해 지도와 원본 행을 탐색합니다. 지리 좌표와 SRID 0 평면 좌표를 별도 보기로 표시합니다.
- **Compare**에서 두 캡처 결과의 키와 비교 열을 매핑합니다. 일치 행의 변경을 선택해 그리드 초안에 넣습니다. 두 테이블을 필터 없이 전부 캡처했고 동일 타입의 정수 기본 키를 매핑했다면 한쪽에만 있는 행을 삽입 또는 삭제로 선택할 수 있습니다. 각 변경은 SQL 검토를 거쳐 적용하고 커밋합니다.
- **Save Table Dataset Comparison**으로 활성 연결의 InnoDB 테이블 두 개와 비교 열을 워크스페이스에 저장합니다. **Replay Saved Dataset Comparison**은 같은 읽기 전용 스냅샷에서 정수 기본 키 순서로 테이블당 최대 50,000행을 대조합니다. 보고서에 정확한 집계와 최대 100개 차이 표본을 표시합니다. **Stage Dataset Comparison Changes**는 현재 편집 페이지에서 원래 값과 일치하는 기존 행의 변경을 SQL 검토 초안에 넣습니다.
- 저장된 연결 프로필을 원본으로 선택하면 별도 MySQL 또는 MariaDB 서버의 InnoDB 테이블도 비교할 수 있습니다. 각 서버의 읽기 전용 스냅샷은 독립적으로 시작되며 보고서에 두 읽기 시작 시각이 표시됩니다. 정수와 DECIMAL의 정밀도 및 부호, VARCHAR의 폭·문자 집합·콜레이션, 바이너리 열의 폭을 확인합니다. 원본 프로필이나 테이블 정의가 바뀌면 재생 시 매핑을 다시 선택해야 합니다.
- **Capture Table Copy Source**에서 메모리, 임시 스트리밍 또는 **Stream and Save for Resume**을 선택합니다. 스트리밍은 InnoDB 기본 키 순서의 읽기 스냅샷을 최대 100만 행·1 GiB까지 암호화합니다. 재개를 선택한 스냅샷은 작업 공간에 최대 24시간 두고 키는 VS Code Secret Storage에 저장합니다. **Copy Captured Rows**에서 대상을 다시 검토하고 새 트랜잭션에 스테이징한 뒤 **Finish Table Copy**에서 커밋 또는 롤백합니다. 커밋 결과가 불확실한 스냅샷은 재사용이 잠깁니다.
- **Verify Table Copy Destination**은 새 미확정 커밋 기록의 검토된 대상에서 최대 128개 기본 키와 매핑된 값을 읽기 전용으로 대조합니다. 표본의 현재 상태를 보고하며 재실행 잠금은 유지됩니다.
- **Show Table Copy Verification History**에서는 최근 점검의 시각·대조 건수·결과를 확인할 수 있습니다. 원본 키나 행 값은 점검 이력에 저장하지 않습니다.
- **Review Table Copy Verification**은 최신 점검 결과를 확인한 뒤 검토 완료, 후속 확인 필요 또는 외부 처리 기록을 남깁니다. **Export Table Copy Verification History**는 점검과 검토 내역을 새 JSON 파일로 저장합니다. 검토는 과거 커밋을 미확정으로 표시하며 재실행 잠금을 유지합니다.
- **Verify All Table Copy Keys**는 새 미확정 기록의 암호화 스냅샷에 매핑된 전체 기본 키를 같은 대상 읽기 스냅샷에서 여러 배치로 대조합니다. **Preview Table Copy Recovery**는 최신 점검과 운영자 판단을 바탕으로 후속 확인 절차를 표시합니다.
- **Show Table Copy Verification Runs**는 배치 진행 상황과 완료·취소·중단 기록을 재시작 후에도 표시합니다. 새 대조는 새 읽기 스냅샷에서 처음부터 확인합니다.
- 운영자가 전체 대조 결과를 후속 확인 대상으로 표시하면 **Review Table Copy Recovery SQL**에서 매개변수가 있는 키 조회와 조건부 INSERT·UPDATE 템플릿을 검토할 수 있습니다. 현재 스키마와 보존한 전송 기록을 확인하며, 템플릿 검토 중에도 재실행 잠금이 유지됩니다.
- 호환되는 `BIT(64)`, `YEAR`, 같은 레이블의 `ENUM`·`SET`, 같은 길이의 고정 `BINARY`도 테이블 복사에서 검증합니다.
- **Open Schema Diagram**에서 실제 FK와 저장 연결의 워크스페이스 가상 FK를 탐색합니다. 노드 위치를 저장하거나 JSON으로 교환하고 PNG로 내보낼 수 있습니다.
- **Save Schema DDL**에서 InnoDB 테이블, 외래 키, 지원하는 뷰, SQL/PSM 프로시저, 결정적 숫자 함수, 트리거의 복원 순서를 검토하고 Git으로 추적할 SQL 파일을 저장합니다. 선택 모드에서는 대상 테이블에 연결된 트리거와 호출하는 프로시저를 포함합니다. 확인할 수 없는 본문, 동적 SQL, 교차 스키마 참조, 순서를 확인할 수 없는 트리거는 생략 이유를 표시합니다. 저장 직전에 서버 정의를 다시 비교합니다. 파일에는 행 데이터, 권한, 이벤트, 시퀀스와 패키지를 포함하지 않습니다. 복원할 때는 동일한 이름과 기본 콜레이션의 빈 스키마와 원래 DEFINER 계정을 준비하고 호환되는 UTF-8 MySQL·MariaDB 클라이언트에서 파일을 검토한 뒤 실행합니다.
- **Save Schema Snapshot with Stored Objects**로 프로시저, 함수, 트리거, 이벤트의 관찰 가능한 원문과 생성 설정을 스냅샷에 저장합니다. 다른 연결에서 **Compare Current Database with Schema Snapshot**을 실행해 같은 이름·종류의 원문과 설정을 비교하고 **Open Stored Object Diff**에서 나란히 엽니다. 보이지 않는 원문과 한쪽 계정에만 보이는 객체는 미확정으로 표시합니다. 비교 결과는 검토용이며 저장 객체 배포나 SQL 의미 동등성을 판단하는 데 사용하지 않습니다.
- **Compare Schema Snapshot with Options**에서 식별자의 정확한 철자 또는 ASCII 대소문자 무시와 CREATE 헤더의 DEFINER 계정 포함 여부를 각각 선택합니다. 비교 보고서에 양쪽 엔진의 테이블 이름 규칙과 모호한 이름을 표시합니다. **Open Compared Table or View DDL**에서 비교에 사용한 원문을 열 수 있습니다. SQL SECURITY, 본문과 리터럴은 비교에 포함하며, 변경을 적용하려면 일반 스키마 비교에서 다시 검토합니다.
- 테이블 디자이너에서 NULL을 허용하는 부호 있는 정수·DECIMAL 생성 열을 추가하거나 수정할 수 있습니다. 앞에 선언된 일반 숫자 열을 참조해 괄호와 `+`, `-`, `*` 표현식을 작성하고 Virtual 또는 Stored를 선택합니다. MySQL은 `STORED`, MariaDB는 `PERSISTENT`로 검토합니다. 기존 테이블을 재구성할 때 일반 열만 복사하고 서버가 계산한 결과를 확인합니다. 함수·서브쿼리·생성 열 연쇄 참조·생성 열의 인덱스나 외래 키·일반 열과 생성 열 사이의 변환에는 별도 검토가 필요합니다.

테이블 설계와 기존 뷰·프로시저 원문 편집은 검토·명시적 적용 흐름을 제공합니다. 서버 검증에는 DDL 권한이 필요할 수 있습니다. MySQL/MariaDB DDL과 객체 교체에는 비원자적인 단계가 있으므로 표시된 범위·복구 조건·미완료 트랜잭션을 확인하세요. 모호한 결과를 자동 재실행하지 않습니다.

실제 서버 검증 도구는 소유한 임시 loopback 인스턴스와 합성 데이터를 위한 것입니다. 운영 DB에 검증용 fixture 도구를 연결하지 마세요.

## 진행 상태와 다음 목표

216개 기능의 현재 상태는 [기능표](docs/FEATURES.md)에서 확인합니다. 가중 점수는 (구현 + VS Code 기본 제공 + 부분 구현 × 0.5) ÷ 216으로 계산합니다. 각 릴리스의 실제 실행과 검증 범위는 [검증 요약](docs/verification.json)에 기록합니다.

## 공개 저장소 관리

원본 소스·합성 fixture·빌드 도구·고지문을 공개합니다. 자격 증명, 런타임 설치본, DB 인스턴스, 원본 제품 조사 자료와 로컬 원시 검증 로그는 공개 커밋에서 제외합니다. Craft Anything은 선택적인 유지관리용 CLI 도구이며 확장의 실행 의존성이 아닙니다.

게시 전후의 검사 방법과 재현 범위는 [공개 소스·검증 안내](https://github.com/Fenrindale/Rocketbrain/blob/main/docs/public-source.md)를 따릅니다. 공개 검증 요약은 실제 수행한 버전과 범위만 기록해야 합니다.

프로젝트 자체 코드의 배포 라이선스는 아직 선택되지 않아 `package.json`의 **UNLICENSED**를 유지합니다. 저장소의 공개 설정만으로 별도의 사용·재배포 라이선스가 부여되지는 않습니다. 외부 구성요소에는 각 구성요소의 라이선스가 적용됩니다.

For mutual TLS, select **Verify CA and server identity** in the connection editor, then choose **PEM certificate and encrypted key** or **PKCS#12 identity**. Set the server DNS name and its CA independently from the client files. An encrypted PEM needs the matching certificate and key. A PKCS#12 file needs exactly one private-key identity and a certificate chain, plus an independent JDK 25 or newer configured through **rocketbrain.java.javaHome**. Rocketbrain asks for the client passphrase on each connection attempt and keeps it out of profile exports and Secret Storage. Portable exports preserve the identity type. Select the files again on the destination machine.

The SQL editor analyzes common JSON calls against the current catalog. It checks argument counts and highlights malformed literal documents or paths in place. MySQL JSON arrows and engine-specific wildcard rules are interpreted using the selected dialect and observed version. Paths supplied by a parameter or column remain runtime-dependent.
