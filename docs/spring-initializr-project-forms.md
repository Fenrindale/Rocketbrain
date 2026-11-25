# Spring Initializr 프로젝트 만들기

**Rocketbrain: Create Spring Project**에서 Initializr 서비스와 Maven 또는 Gradle 빌드 형식을 선택합니다. 서비스가 제공하는 Spring Boot 버전과 호환 스타터를 사용합니다. 표준 프로젝트는 Java, Kotlin, Groovy와 JAR, WAR를 선택할 수 있습니다. 서비스가 지원하면 `application.properties` 또는 `application.yaml`도 선택할 수 있습니다.

Rocketbrain이 받은 ZIP에서 선택한 빌드 파일, 언어 소스 디렉터리, 패키징 선언, 설정 파일을 확인합니다. 검토 탭에서 생성될 파일과 SHA-256을 살펴보고 각 파일을 열 수 있습니다. **Apply Spring Project Review**를 실행하면 승인한 파일을 새 디렉터리에 씁니다. 이미 파일이나 폴더가 있는 목적지는 거부합니다.

열려 있는 Java 워크스페이스의 초기 가져오기는 별도 실행 승인이 필요합니다. 생성 후에는 필요할 때 프로젝트를 가져오거나 빌드할 수 있습니다. WAR 프로젝트를 외부 Servlet 컨테이너에 배포하려면 호환되는 서버를 준비합니다. [Spring Boot WAR 배포](https://docs.spring.io/spring-boot/how-to/deployment/traditional-deployment.html)
