# Spring Boot 설정 YAML과 생성 메타데이터

`application.yml`, `application.yaml`, `application.properties`의 설정 키를 편집하면 Rocketbrain이 같은 모듈의 Spring Boot 설정 메타데이터로 자동완성합니다. Gradle의 `build/classes`와 Maven의 `target/classes` 아래 생성된 `META-INF/spring-configuration-metadata.json`도 읽습니다. Rocketbrain은 편집을 위해 빌드를 실행하지 않습니다.

생성 메타데이터가 설정 키를 단일 로컬 Java 타입에 연결하면 **Go to Definition**으로 해당 필드나 타입 선언을 엽니다. Java의 `@Value`에서 정의로 이동하면 선택한 로컬 프로필에 해당하는 설정 키를 엽니다. YAML에서 여러 문서, 흐름 매핑과 목록, 앵커·별칭·병합, 여러 줄 값과 정확한 선언 위치를 지원합니다. 같은 위치에서 프로필별 파일과 properties 파일의 우선순위를 반영합니다.

사용자 정의 YAML 태그와 키, 순환 별칭, 일부 중첩 Java 메타데이터, 복합 구성 로더는 지원 범위 밖입니다. 클라우드 조건이나 외부 가져오기로 적용 값이 달라질 수 있는 파일은 정적 모델에서 불확실하게 표시합니다. 실행 중인 앱의 실제 값을 확인하려면 **Inspect Spring Property Value and Origin**으로 Actuator에 연결해 해당 키를 조회합니다. [런타임 설정 출처](spring-property-origin.md)
