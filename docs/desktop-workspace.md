# Rocketbrain Desktop 작업창과 업데이트

Rocketbrain Desktop 0.2.0-preview.1은 Windows x64 시제품이다. 내장 확장은 0.180.0이다. 앱의 작업창에서 Java와 Database 모드를 선택하면 전용 도구와 도킹 구성이 바뀐다.

| 영역 | Java 모드 | Database 모드 |
| --- | --- | --- |
| 상단 | Build, Run, Debug, Test, Java Setup | 연결 추가, SQL 콘솔, 실행, 커밋, 롤백 |
| 왼쪽 | 프로젝트와 Java 작업 | 데이터베이스와 스키마 |
| 중앙 | Java 편집기 또는 프로젝트 시작 화면 | SQL 콘솔과 데이터 편집 |
| 오른쪽 | 파일 구조 | 작업 파일 탐색 |
| 하단 | 실행, 디버그, 오류, 터미널 도구 | 쿼리 결과와 편집 |

도구 위치는 각 작업의 흐름에 맞추고 아이콘과 색상은 Rocketbrain 디자인을 사용한다. 모드 도구창은 해당 버튼으로 열고 닫을 수 있다. [IntelliJ Project Structure](https://www.jetbrains.com/help/idea/project-settings-and-structure.html) · [DataGrip 작업창 구성](https://www.jetbrains.com/help/datagrip/guided-tour-around-the-user-interface.html)

## Java 첫 실행

Java 프로젝트를 열면 사용 가능한 독립 JDK와 Java 엔진을 확인한다. 이미 설치된 런타임을 사용할 수 있으면 엔진을 시작한다. 설정이 필요하면 상단 **Java Setup**에서 현재 상태를 확인하고 JDK 위치를 선택하거나 관리형 런타임 설치를 요청할 수 있다. 런타임 다운로드는 설정 화면에서 요청한 경우에 시작한다.

## GitHub Releases 업데이트

상단 **Check for Updates** 또는 Help의 **Check for Rocketbrain Updates**로 확인한다. 현재 앱의 버전과 같은 배포 채널에서 더 높은 Windows x64 버전이 있으면 다운로드를 선택할 수 있다. 다운로드 파일은 릴리스의 설치 파일 이름·크기·SHA-256과 대조한다. 확인이 끝난 후 **Quit & Install**을 선택하면 Windows 설치 화면이 열린다. 시험판의 서명 상태는 설치 전에 표시한다. [Rocketbrain Releases](https://github.com/Fenrindale/Rocketbrain/releases) · [GitHub release 자산 메타데이터](https://docs.github.com/en/rest/releases/assets)

0.1.0-preview.1에서 처음 올라올 때는 앱을 닫고 GitHub Release의 새 설치 파일을 실행한다. 같은 위치에 설치하면 앱 데이터 경로를 계속 사용한다.

패키지 빌드는 설치 파일과 `RocketbrainDesktop-<version>-win32-x64-update.json`을 함께 생성한다. 두 파일은 해당 소스 커밋의 `desktop-v<version>` 릴리스에 제공한다. 시험판에는 시험판 태그와 GitHub prerelease 표시를 사용한다.
