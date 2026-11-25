# Boot BOM으로 관리하는 Maven 스타터 편집

명령 팔레트에서 **Rocketbrain: Edit Spring Starters**를 실행하고 프로젝트의 `pom.xml`을 선택합니다. Maven에서 Spring Boot 부모 POM 없이 `org.springframework.boot:spring-boot-dependencies`를 직접 가져오는 프로젝트도 편집할 수 있습니다.

- BOM은 `dependencyManagement`에 `type=pom`과 `scope=import`로 한 번 선언해야 합니다. 버전은 문자열 또는 같은 POM의 값이 하나로 정해진 속성으로 지정할 수 있습니다.
- 편집할 스타터와 드라이버를 고른 뒤 BOM 출처와 삭제·추가될 의존성의 diff를 검토합니다. 로컬 `dependencyManagement`에서 버전을 직접 지정한 의존성은 선택에서 보호합니다.
- 적용하면 Maven 직접 의존성 블록이 저장됩니다. Maven이 빌드할 때 실제 버전을 해석합니다. 저장한 뒤 필요하면 별도로 프로젝트를 다시 동기화하거나 Maven 빌드를 실행할 수 있습니다.

외부 부모 상속, 활성 프로필, 추가 BOM, Gradle 버전 카탈로그 및 복잡한 빌드 모델을 사용하는 프로젝트는 해당 빌드 파일에서 직접 편집합니다.
