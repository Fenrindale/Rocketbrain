# Rocketbrain 작업 화면 관찰과 구현 기준

Windows의 IntelliJ IDEA 2026.3 빌드 `263.7307.200.0-IU`와 DataGrip 2026.3 빌드 `263.7307.216.0-DB`를 기준으로 삼는다. 별도 테스트 프로필에서 만든 Java·SQL 파일로 화면을 연다. 실제 화면에서 확인한 위치와 제품 도움말에서 확인한 동작을 기록한다. [IntelliJ IDEA 작업 화면](https://www.jetbrains.com/help/idea/guided-tour-around-the-user-interface.html) · [DataGrip 작업 화면](https://www.jetbrains.com/help/datagrip/guided-tour-around-the-user-interface.html)

## 관찰과 구현 절차

1. 별도 프로필에서 합성 프로젝트를 열고 Craft Anything CLI의 `--clean-room native-window-capture`로 화면과 접근성 트리를 기록한다. 접근성 트리에 버튼이 노출되면 `runtime-ui-walkthrough-record`로 해당 버튼을 눌러 이후 상태를 확인한다.
2. 구현에 전달할 기록은 작업 영역, 조작 이름, 표시·활성화 조건, 입력, 예상 결과다. 원본 화면과 접근성 덤프는 로컬 관찰 자료로 보관한다.
3. Rocketbrain 작업창에서 해당 기능과 위치를 연결한다. 원본 내부 코드와 시각 자산은 독립 구현의 입력에서 제외한다.
4. 설치본에서 해당 영역의 버튼이나 입력을 사용해 결과를 확인한다. 조건이 달라지는 경우 빈 프로젝트, 활성 문서, 연결 또는 실행 중 상태를 각각 검증한다. 명령 팔레트 경로만 확인한 항목은 버튼 조작 확인으로 집계하지 않는다.

## 2026-11-27 설치본 관찰

- IntelliJ IDEA의 Maven 샘플 프로젝트에서 왼쪽 Project의 `src`, `pom.xml`, 라이브러리와 상단의 현재 파일 선택·실행·디버그 도구를 확인했다. 실행할 편집기가 선택되지 않은 상태에서 실행·디버그 아이콘은 비활성이었다. 별도의 파일 열기 캡처에서는 중앙 Java 편집기를 확인했다.
- DataGrip의 빈 샘플 프로젝트에서 왼쪽 Database Explorer의 연결 추가와 MySQL 진입점, 중앙의 연결 생성, 오른쪽 Files의 `audit.sql`을 확인했다. SQL 파일 단독 열기에서는 중앙 SQL 편집기가 표시됐다. 연결 이후 콘솔과 결과 동작의 참조 근거는 공식 도움말이며, MySQL·MariaDB 실행과 그리드 커밋은 Rocketbrain 설치본에서 확인했다. [DataGrip SQL 실행](https://www.jetbrains.com/help/datagrip/run-a-query.html)
- Windows 접근성 기록에서 DataGrip의 Database Explorer를 대상으로 한 CLI 동작은 `element_not_found`였다. 원본의 버튼 위치는 화면 관찰로 기록했다. Rocketbrain 설치본에서 직접 실행한 조작과 로컬 캡처의 확인값은 [설치본 검증](desktop-workspace-verification.json)에 있다.

## Java

| 사용자 조작 | 레퍼런스 영역과 조건 | Rocketbrain 구현·확인 기준 |
| --- | --- | --- |
| 프로젝트와 빌드 파일 열기 | 왼쪽 Project에서 프로젝트, 소스와 빌드 파일을 펼친다. | 왼쪽 Project에서 Java 파일을 열고, Java Projects에서 가져온 모듈과 빌드 작업을 찾는다. |
| 실행 구성 고르기 | 상단 실행 도구에서 현재 파일 또는 저장 구성을 고른다. Java 실행점이나 저장 구성이 있으면 Run과 Debug를 사용한다. | 상단 Run·Debug에서 구성을 선택한다. 실행 전에 구성을 고르고 선택 상태를 상단에 표시하는 조작은 후속 항목이다. |
| 실행·디버그 | 프로젝트가 준비되면 상단 실행 버튼 또는 실행 가능한 코드 옆에서 시작한다. | 상단 Run·Debug 버튼으로 실제 JVM을 시작한다. 하단에서 출력 또는 중단을 확인한다. 편집기 여백과 상단의 실행 대상 일치도 별도로 확인한다. |
| 메서드 선언으로 이동 | Java 편집기의 해석 가능한 참조에서 선언으로 이동한다. | Java 엔진 준비 후 호출의 식별자를 Ctrl+클릭하고 선언 파일이 열리는지 확인한다. |
| JDK 및 Maven·Gradle 설정 | 프로젝트 구조와 빌드 도구 설정에서 해당 프로젝트의 JDK 및 빌드 설정을 찾는다. | 상단 Java Setup으로 첫 설정을 연다. 프로젝트별 JDK 및 빌드 도구는 같은 화면에서 접근할 수 있게 하고 각각 실제 설정 반영을 확인한다. |

[실행 및 디버그 구성](https://www.jetbrains.com/help/idea/run-debug-configuration.html) · [프로젝트 설정 및 구조](https://www.jetbrains.com/help/idea/project-settings-and-structure.html) · [코드 탐색](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html)

## Database

| 사용자 조작 | 레퍼런스 영역과 조건 | Rocketbrain 구현·확인 기준 |
| --- | --- | --- |
| 새 데이터 소스 추가 | 왼쪽 Database Explorer에 연결 추가 버튼을 둔다. 빈 프로젝트에서 연결 생성이 가능하다. | 왼쪽 Database Connections 및 상단의 연결 추가를 통해 MySQL·MariaDB 양식을 연다. 신규 연결과 저장 연결의 진입점을 각각 확인한다. |
| SQL 콘솔 열기 | 왼쪽 탐색기에서 데이터 소스를 고르고 콘솔을 열면 중앙 편집기로 이동한다. | 연결된 탐색기 행 또는 상단에서 콘솔을 열고 실행 대상 연결이 동일한지 확인한다. |
| 현재 SQL 실행 | 중앙 SQL 편집기의 도구막대 또는 Ctrl+Enter를 사용한다. 결과는 기본적으로 하단 Database Output에 표시된다. | 상단 SQL 도구 또는 Ctrl+Enter로 현재 문장이나 선택 영역을 실행한다. 하단 Query Results에서 실행한 문장의 결과를 확인한다. |
| 테이블 데이터 편집 | 테이블을 열고 데이터 그리드에서 셀을 선택해 수정한다. 연결 및 결과의 편집 가능 여부에 따라 조작이 바뀐다. | 왼쪽 탐색기의 테이블 행에서 미리보기를 연다. 하단 그리드에서 셀을 수정·검토하고 커밋한 값을 별도 세션으로 확인한다. |
| 트랜잭션 완료 | 활성 SQL 세션의 트랜잭션 상태에서 커밋과 롤백을 찾는다. | SQL 도구와 하단 결과의 관련 버튼을 실제 세션에 연결한다. 미커밋과 커밋 후의 가시성을 비교한다. |

[데이터베이스 탐색기](https://www.jetbrains.com/help/datagrip/database-explorer.html) · [SQL 실행](https://www.jetbrains.com/help/datagrip/run-a-query.html) · [하단 결과 도구창](https://www.jetbrains.com/help/datagrip/database-output-tool-window.html)

Rocketbrain 설치본에 대한 조작별 결과는 [설치본 검증](desktop-workspace-verification.json)에서 확인할 수 있다.
