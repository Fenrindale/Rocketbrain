# Hibernate fetch activity

Prepare the Rocketbrain JPA observer using an independent JDK 25 or newer. Set `performance` to `true` in the generated observer configuration, then restart the application with that Java agent. Connect to its loopback observer in VS Code. The configuration leaves fetch activity disabled by default.

Run **Inspect Hibernate Fetch Activity** and choose a retained request. The view shows successful Hibernate SELECTs and JDBC execution time grouped within one Spring MVC request. A finding requires an earlier SELECT from the mapped owner table and repeated collection loads for distinct owners in the same Hibernate session. A load can use a scalar key or a supported Hibernate embedded key with two to four columns. The predicate must bind each mapped key column exactly once for that owner. The report includes the entity, collection role, key columns, and actual parent and child SQL templates. Composite key parts are combined into one request-local ordinal.

The capture retains up to 12 request samples and 40 SELECTs per request. For a supported Spring MVC `Callable`, one request contains the initial servlet phase, the Spring worker and the linked async redispatch. Each SELECT identifies its phase. A timeout, missing worker or redispatch, truncated capture, and unsupported async path such as `DeferredResult` have partial coverage when captured. The view keeps concurrent requests separate. Explicit repeated application queries and repeated loads of the same key are outside this collection N+1 rule.

The observer records method and route pattern when available. It omits request parameters, raw bind values, SQL literals, and query rows. Owner key ordinals are scoped to the request. The identified timings measure JDBC execution and exclude row iteration. The observer reads already executed application queries and does not issue SQL itself.

The reviewed request also lists observed JDBC bind positions for each SQL template. A position is the one-based index used by a successful `PreparedStatement` setter on that execution. The reported JDBC type comes from the standard setter family or an explicit JDBC type argument. It describes the bind operation. The database column type and driver wire representation have independent type rules. Untyped `setObject` calls have no inferred type. No actual bind values are collected.

Each SELECT retains up to 16 observed positions. Unknown, unsupported or excess positions produce partial bind coverage. The earlier observer versions show request activity without bind evidence. Collection N+1 findings keep their own coverage and key checks, including the supported embedded keys.

The supported hooks were verified with Spring MVC 7.0.10 and Hibernate 7.4.13.Final. The collection rule covers scalar keys and supported composite keys. Other provider/runtime versions, to-one loaders, application-created executor tasks, WebFlux, and general database query attribution have separate coverage.

[Spring MVC asynchronous requests](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html) · [Hibernate ORM fetch strategies](https://docs.hibernate.org/stable/core/userguide/html_single/) · [Hibernate 7.4 fetch joins](https://docs.hibernate.org/orm/7.4/querylanguage/html_single/)
