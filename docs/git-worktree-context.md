# Git worktree별 프로젝트 문맥

신뢰한 로컬 작업 공간에서 **Rocketbrain: Manage Git Worktree Context**를 실행합니다. 열린 편집기의 Git worktree를 기준으로 JDT에 가져온 Java 프로젝트, 로컬 Spring Actuator 주소, 저장한 DB 프로필을 선택해 둘 수 있습니다.

- **Inspect Java Project**에서 이 worktree의 JDK·언어 수준·클래스 경로를 확인하고 실제 빌드 파일을 엽니다.
- **Inspect Spring Service Health**에서 지정한 루프백 Actuator를 조회합니다.
- **Open Dedicated Database Console**은 이 worktree에 저장한 연결 프로필로 전용 SQL 콘솔을 엽니다. 프로필을 편집한 뒤에는 새 버전을 다시 선택합니다.
- **Open a Linked Worktree**에서 현재 Git 저장소가 등록한 연결 worktree를 새 VS Code 창으로 엽니다.

설정은 현재 Rocketbrain 설치의 로컬 상태에 물리 worktree별로 저장됩니다. DB 연결은 열린 작업 공간에서 동일한 프로필 ID와 버전을 찾을 수 있을 때 사용할 수 있습니다. 설정을 지우려면 **Clear Worktree Context**를 선택합니다.
