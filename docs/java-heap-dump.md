# JVM 힙 덤프 분석

신뢰한 VS Code 작업 공간에서 **Rocketbrain: Inspect JVM Heap Dump**를 열고 로컬 HotSpot `.hprof` 파일을 선택합니다. HotSpot의 `jcmd <pid> GC.heap_dump dump.hprof`로 생성한 HPROF 1.0.1·1.0.2 단일 스냅샷을 사용할 수 있습니다. 파일은 로컬에서 읽습니다.

- **Heap Summary**에서 기록된 객체, 모델링된 참조, GC 루트와 누락된 객체 레코드 참조 수를 확인합니다.
- **Largest Retained Objects**에서 관찰된 그래프의 retained payload가 큰 객체를 고릅니다. **Find Objects by Java Type**이나 **Inspect an Object ID**로 특정 객체에 접근할 수 있습니다.
- 객체의 **Path to GC Root**는 기록된 GC 루트까지 이어지는 최단 참조 경로를 표시합니다. 들어오거나 나가는 필드와 배열 참조를 따라갈 수 있고, **Open Immediate Dominator**로 선택한 객체의 수명을 유지하는 지배 객체를 확인합니다.

Shallow와 retained 바이트는 HPROF에 기록된 필드·배열 payload를 기준으로 계산합니다. VM 물리 메모리 비교에는 **Inspect JVM Heap Histogram**을 함께 사용할 수 있습니다. Retained 결과는 기록된 루트와 관찰 가능한 참조를 기준으로 하며, `java.lang.ref.Reference.referent`를 제외합니다. 분석 한도는 64 MiB, 객체 30만 개, 참조 150만 개입니다.
