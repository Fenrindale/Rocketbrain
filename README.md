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
| DB·SQL | 연결 프로필·TLS·SSH, 지속 세션·트랜잭션, SQL 작성·실행·분석, 결과 그리드 편집·가져오기, 테이블 설계·객체 원문 편집, 스키마 비교·복구 | 동시에 여러 활성 연결, 모든 SQL 문법·객체 작성 형식·타입 변환, 서버 간 원자적 DDL은 완성되지 않았습니다. |
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
4. **Build Java Project / Choose Build Task**, 저장한 **Run / Debug / Stop** 구성을 사용합니다.
5. **Create Spring Project**로 공식 Initializr 프로젝트를 생성하거나 **Edit Spring Starters**로 지원하는 의존성 변경을 검토합니다.
6. **New Java File from Template**에서 소스 루트·패키지·템플릿을 골라 파일을 만듭니다. `rocketbrain.java.fileTemplates`에서 사용자 템플릿과 변수 `${name}`, `${package}`, `${packageDeclaration}`를 사용할 수 있습니다.
7. **New JShell Scratch**로 저장할 코드를 만들고 **Run JShell Scratch**로 독립 JDK에서 실행합니다. 프로젝트 클래스가 필요하면 실행할 때 관찰된 로컬 클래스 경로를 선택합니다.

기존 독립 런타임을 사용할 때는 `rocketbrain.java.javaHome`, `rocketbrain.java.serverPath`, 필요한 디버그 번들을 설정합니다. 서버용 JDK와 프로젝트용 JDK는 별개이며 프로젝트 JDK는 `rocketbrain.java.projectJdks`로 선택합니다. 원본 IDE의 내장 JBR은 거부합니다.

Java 프로젝트 가져오기와 빌드는 프로젝트 코드를 실행할 수 있습니다. 신뢰한 프로젝트만 열고, 명시적인 동기화·빌드·실행·생성/의존성 적용 단계의 안내를 확인하세요. 최초 가져오기와 일반 Java 소스 자동 빌드도 신뢰한 작업 공간에서 수행됩니다. DB 연결 환경 값과 저장한 실행 환경 값은 Secret Storage를 사용합니다.

## 검토하는 Java 리팩터링

Java 선언을 선택하고 명령 팔레트를 사용합니다. 변경 전후와 파일 작업을 검토한 뒤 적용합니다. 텍스트 편집과 클래스 이동에는 VS Code Undo를 사용합니다. Safe Delete로 지운 파일은 **Restore Deleted Java File**에서 복원합니다. 검토 뒤 원본·참조·리소스가 바뀌면 다시 검토해야 합니다.

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

**Database Connections**에서 MySQL/MariaDB 프로필을 만들고 연결을 검증합니다. 여러 저장 프로필 중 하나가 활성 연결입니다. SQL 콘솔에서 문장·선택 구간을 실행하고, 결과 그리드의 수정·추가·삭제를 검토한 뒤 트랜잭션을 적용하거나 되돌립니다.

- **Set SQL Session Isolation**은 열린 SQL 콘솔의 연결에 격리 수준을 적용하고 서버 값을 다시 확인합니다. 트랜잭션과 검토 중인 그리드 초안이 있으면 먼저 정리해야 합니다.
- **Save SQL Query**는 현재 선택 구간이나 문서를 작업 공간에 저장합니다. **Saved SQL Queries**에서 검색·즐겨찾기·열기와 활성 연결을 사용한 새 읽기 전용 콘솔 실행을 제공합니다.
- `JOIN` 뒤 테이블 자동 완성은 현재 스키마에서 확인된 외래 키마다 `ON` 조건을 제안합니다. 복합 외래 키의 모든 열을 선언 순서대로 포함합니다.
- 결과 탭은 Grid·Record·Tree·Text·Transpose 보기와 열 레이아웃을 제공합니다. Export는 캡처한 결과 페이지의 전체 열을 CSV, JSON, Excel 또는 검토용 INSERT SQL로 저장합니다.

테이블 설계와 기존 뷰·프로시저 원문 편집은 검토·명시적 적용 흐름을 제공합니다. 서버 검증에는 DDL 권한이 필요할 수 있습니다. MySQL/MariaDB DDL과 객체 교체에는 비원자적인 단계가 있으므로 표시된 범위·복구 조건·미완료 트랜잭션을 확인하세요. 모호한 결과를 자동 재실행하지 않습니다.

실제 서버 검증 도구는 소유한 임시 loopback 인스턴스와 합성 데이터를 위한 것입니다. 운영 DB에 검증용 fixture 도구를 연결하지 마세요.

## 진행 상태와 다음 목표

216개 기능의 현재 상태는 [기능표](docs/FEATURES.md)에서 확인합니다. 가중 점수는 (구현 + VS Code 기본 제공 + 부분 구현 × 0.5) ÷ 216으로 계산합니다. 각 릴리스의 실제 실행과 검증 범위는 [검증 요약](docs/verification.json)에 기록합니다.

## 공개 저장소 관리

원본 소스·합성 fixture·빌드 도구·고지문을 공개합니다. 자격 증명, 런타임 설치본, DB 인스턴스, 원본 제품 조사 자료와 로컬 원시 검증 로그는 공개 커밋에서 제외합니다. Craft Anything은 선택적인 유지관리용 CLI 도구이며 확장의 실행 의존성이 아닙니다.

게시 전후의 검사 방법과 재현 범위는 [공개 소스·검증 안내](https://github.com/Fenrindale/Rocketbrain/blob/main/docs/public-source.md)를 따릅니다. 공개 검증 요약은 실제 수행한 버전과 범위만 기록해야 합니다.

프로젝트 자체 코드의 배포 라이선스는 아직 선택되지 않아 `package.json`의 **UNLICENSED**를 유지합니다. 저장소의 공개 설정만으로 별도의 사용·재배포 라이선스가 부여되지는 않습니다. 외부 구성요소에는 각 구성요소의 라이선스가 적용됩니다.
