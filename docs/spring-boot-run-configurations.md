# Spring Boot 실행 설정

**Rocketbrain: Configure Spring Boot Run**에서 가져온 Java 프로젝트와 main 클래스를 선택합니다. 기존 Java 실행 구성과 같은 JDK, 인수, 환경 변수와 사전 빌드 작업을 사용할 수 있습니다.

활성화할 프로필을 쉼표로 구분해 입력합니다. 프로필과 각 Spring Boot 설정은 OS 환경 변수, JVM 시스템 속성(`-D`), 또는 Spring 애플리케이션 인수(`--`) 중 하나로 전달할 수 있습니다. 같은 키가 일반 인수나 환경 변수에 있으면 한 곳을 선택합니다. 저장 전에는 프로필 이름과 설정 키, 전달 방식을 검토합니다.

이름과 출처 선택은 실행 구성에 저장하며 설정값은 VS Code Secret Storage에 보관합니다. 운영체제 환경이나 프로세스 인수를 조회할 수 있는 로컬 프로그램은 선택한 전달 방식의 값을 볼 수 있습니다. 실행 후에는 **Inspect Spring Property Value and Origin**을 사용해 앱이 실제로 선택한 값을 확인합니다. Spring 앱의 다른 설정과 우선순위가 적용됩니다. [Spring Boot 외부 설정](https://docs.spring.io/spring-boot/reference/features/external-config.html)
