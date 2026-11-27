# Rocketbrain Desktop Preview

최신 독립 앱의 화면 구성, Java 설정, 업데이트는 [Rocketbrain Desktop 작업창과 업데이트](desktop-workspace.md)에 있다. 이 문서는 0.1.0-preview.1 설치 검증을 기록한다.

Rocketbrain Desktop 0.1.0-preview.1은 Windows x64용 독립 설치 시제품이다. Code OSS 1.143.1 기반의 VSCodium 1.143.17232 배포본에 Rocketbrain 작업창 패치와 Rocketbrain 0.179.1 확장을 내장한다. 별도의 VS Code 설치 없이 실행할 수 있다. [Code OSS 소스](https://github.com/microsoft/vscode/tree/1.143.1) · [기반 배포본](https://github.com/VSCodium/vscodium/releases/tag/1.143.17232)

## 설치와 실행

1. `RocketbrainDesktop-0.1.0-preview.1-win32-x64-setup.exe`를 실행하고 설치 위치를 선택한다. 설치 후 시작 메뉴에서 **Rocketbrain Desktop**을 열 수 있다.
2. Java 작업 공간을 열고 상단 **Java Mode**를 누른다. Java 엔진 설정이 필요한 경우 **Java Projects** 뷰의 설정 경로를 사용한다. 상단의 **Run Java**와 **Debug Java**는 현재 Rocketbrain 실행 구성을 사용한다.
3. 상단 **Database Mode**를 누르면 왼쪽 **Database**와 하단 **Query Results**가 열린다. 신규 연결은 Database 헤더에서 추가하고, 상단에서 **Open SQL Console**을 누른 뒤 `Ctrl+Enter`로 SQL을 실행한다.
4. 편집이 허용된 테이블의 미리보기에서 셀 변경을 준비하고 검토 후 적용한다. 수동 트랜잭션을 연 세션에서는 커밋 후 변경이 저장된다.

모드 선택은 작업 공간별로 저장된다. 독립 앱은 별도의 사용자 데이터 폴더와 설치 경로를 사용한다. 이번 Windows 설치 프로그램은 코드 서명을 포함하지 않으며 자동 업데이트를 제공하지 않는다.

## 소스와 패키지 재현

`desktop/windows-x64.json`에 기준 버전, 공식 Windows x64 아카이브의 SHA-256과 Rocketbrain 확장 버전을 고정한다. `desktop/workbench/rocketbrainTitlebar.ts`는 상단에 작업을 등록하는 Code OSS 소스다. 패치 스크립트는 기준 작업창 파일의 SHA-256을 확인한 뒤 같은 메뉴 등록 코드를 배포본에 적용한다. `--source`로 지정한 Code OSS 소스 체크아웃에도 등록 코드를 적용할 수 있다.

의존성을 설치한 저장소에서 `node scripts/package.js`로 VSIX를 만든다. 고정된 [기반 ZIP](https://github.com/VSCodium/vscodium/releases/tag/1.143.17232)과 Inno Setup 컴파일러를 준비하고 PowerShell 7.2 이상에서 실행한다.

```powershell
./scripts/package-desktop.ps1 -BaseArchive $BaseZip -ExtensionVsix ./rocketbrain-0.179.1.vsix -Compiler $Iscc -OutputDirectory $Output
```

설치 프로그램과 패키지 검증 기록이 지정한 출력 폴더에 생성된다. 배포본은 Code OSS와 번들 구성 요소의 라이선스 고지를 포함한다.

## 설치본 검증

Windows 새 프로필에서 설치 프로그램을 실행하고 앱 내장 확장으로 Java와 DB 흐름을 시험했다. Java 모드 버튼으로 프로젝트를 열고 메서드에 실제 `Ctrl+클릭`을 보냈다. 상단 실행 버튼으로 Maven 예제 JVM이 실행됐고, 디버그 버튼으로 건 중단점에서 정지·재개했다.

MariaDB 11.4.8과 MySQL 8.4.13의 각 테스트 서버에서 상단 DB 모드와 콘솔을 열었다. 세미콜론 직후 `Ctrl+Enter`로 하단 결과를 열고, 왼쪽 Database의 테이블 미리보기에서 셀 편집을 준비한 후 SQL 검토·적용·커밋을 수행했다. 별도 SQL 연결로 커밋 전 원래 값, 커밋 후 변경값과 이웃 행의 기존 값을 대조했다. [설치 검증과 파일 해시](desktop-preview-verification.json)

Craft Anything CLI는 내장 VSIX의 39개 항목과 설치된 앱의 작업창 캡처를 확인했다. 데스크톱의 검증 범위는 Windows x64와 소유한 시험 프로젝트 및 DB에 한정한다.
