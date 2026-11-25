# Java 테스트 실행 기록

신뢰한 작업 공간에서 **Rocketbrain: Open Java Test Run History**를 열고 **Enable Java Test History**를 선택합니다. 이후 완료한 실행의 요약과 실패 상세를 같은 작업 공간에서 다시 열 수 있습니다. **Compare Expected and Actual**은 저장한 두 값을 VS Code diff에서 엽니다.

JUnit 3·4의 문자열 비교와 OpenTest4J가 제공한 expected·actual 및 타입을 표시합니다. 구조 정보를 제공하는 TestNG 예외도 이 경로를 사용합니다. 일반 TestNG `Assert`의 단순 비교는 엔진의 비교 문구를 텍스트로 보여줍니다.

기존에 테스트 런타임을 설치했다면 **Install Independent Java Test and Coverage Runtime**으로 현재 확장에 포함된 실행기 소스를 빌드할 수 있습니다.

**Rerun This Saved Failure** 또는 **Rerun Saved Failures**를 선택하면 현재 프로젝트와 테스트가 저장된 ID에 일치할 때 해당 실패를 다시 실행합니다. 일반 JUnit Jupiter·Vintage 테스트 메서드와 TestNG가 재실행 가능하다고 확인한 invocation을 지원합니다. TestNG는 현재 데이터 공급자와 재시도 조건을 다시 검사합니다. 실행에는 현재 작업 공간의 테스트 설정이 적용됩니다.

기록은 작업 공간의 로컬 VS Code 상태에 최대 20개 실행과 합계 2 MiB까지 저장되며, 한 실행의 실패 상세는 최대 60개입니다. **Clear Java Test Run History**에서 저장한 기록을 지울 수 있습니다.
