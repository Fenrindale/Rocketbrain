# Spring Boot 실행 설정

**Rocketbrain: Configure Spring Boot Run**에서 가져온 Java 프로젝트와 main 클래스를 선택합니다. 기존 Java 실행 구성과 같은 JDK, 인수, 환경 변수와 사전 빌드 작업을 사용할 수 있습니다.

활성화할 프로필을 쉼표로 구분해 입력합니다. 프로필과 각 Spring Boot 설정은 OS 환경 변수, JVM 시스템 속성(`-D`), 또는 Spring 애플리케이션 인수(`--`) 중 하나로 전달할 수 있습니다. 같은 키가 일반 인수나 환경 변수에 있으면 한 곳을 선택합니다. 저장 전에는 프로필 이름과 설정 키, 전달 방식을 검토합니다.

이름과 출처 선택은 실행 구성에 저장하며 설정값은 VS Code Secret Storage에 보관합니다. 운영체제 환경이나 프로세스 인수를 조회할 수 있는 로컬 프로그램은 선택한 전달 방식의 값을 볼 수 있습니다. 실행 후에는 **Inspect Spring Property Value and Origin**을 사용해 앱이 실제로 선택한 값을 확인합니다. Spring 앱의 다른 설정과 우선순위가 적용됩니다. [Spring Boot 외부 설정](https://docs.spring.io/spring-boot/reference/features/external-config.html)
## 실행 구성 공유

**Export Shared Java Run**은 열린 작업 공간에 새 `.rocketbrain-run.json` 파일을 저장합니다. 프로젝트의 상대 경로, main 클래스, 빌드 작업, Spring 프로필 전달 방식과 입력이 필요한 환경 변수·속성 이름을 포함합니다. 프로그램 인수와 JVM 옵션은 값 없이 개수만 기록합니다.

**Import Shared Java Run**은 현재 프로젝트와 main 클래스를 확인하고, 검토할 파일의 해시를 표시합니다. 참조한 Maven 또는 Gradle 작업은 Java Projects에서 먼저 가져옵니다. 값을 입력해 로컬 실행 구성을 저장한 뒤 **Run Java Configuration**이나 **Debug Java Configuration**으로 실행합니다. 파일이 바뀌면 다시 검토합니다.

## 여러 구성 실행

**Run Java Configuration Group**으로 저장한 구성 두 개에서 네 개를 목록 순서대로 시작합니다. 각 구성의 사전 작업을 완료한 뒤 해당 JVM을 시작합니다. 시작 중 실패하면 먼저 시작한 그룹 세션을 중지합니다. 실행 중인 세션은 기존 중지 명령으로 관리합니다.
