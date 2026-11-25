# Spring endpoint navigation

Run **Rocketbrain: Spring: Navigate to Endpoint** or search workspace symbols for a path, such as `@/api/people`. Open a result to jump to the controller mapping, WebFlux route call, or Feign method annotation. The endpoint picker identifies MVC and WebFlux as server declarations and Feign as an outbound client contract.

- **Spring MVC** combines literal type and method mappings. A configured or computed path is marked unresolved.
- **Spring WebFlux** recognizes Java `@Bean` methods returning a reactive `RouterFunction` built with Spring’s `RouterFunctions`. It combines literal path prefixes, direct and fluent routes, nested builder or supplier lambdas, and supported conjunctive predicates. Results indicate additional request conditions when the path and method are known. Computed paths, unsupported predicates, branch-built routers, and unsupported builder operations are shown as unresolved when the declaring router is recognized.
- **Spring Cloud OpenFeign** combines the literal `@FeignClient(path = ...)` prefix and a directly declared Spring MVC mapping with one supported method and path. The view excludes client URLs. Inherited contracts, custom Feign configurations, and dynamic prefixes require separate resolution.

Results reflect workspace source. They do not start an application or establish that a bean or route is active in a running deployment. The existing Spring Actuator observer remains a separate source of runtime evidence.

The paired fixture runs Spring WebFlux 7.0.10 on Reactor Netty 1.3.8 and calls it through a registered Spring Cloud OpenFeign 5.1.0 client from a Spring MVC endpoint. The WebFlux GET reaches the owned MySQL or MariaDB server and returns its version. The paired controls check an incorrect method, an unmet request predicate, and an actual computed route shown as unresolved in source. The fixture dependencies are test-only.

[Spring WebFlux functional endpoints](https://docs.spring.io/spring/reference/7.0/web/webflux-functional.html) · [Spring Cloud OpenFeign](https://docs.spring.io/spring-cloud-openfeign/reference/spring-cloud-openfeign.html)
