# Spring Security filter trace

Use **Prepare Local JVM Observer** with an independent JDK 25 or newer. Set `securityTrace` to `true` in the generated configuration and restart the application with the provided JVM arguments. Use **Connect Local JVM Observer** with the loopback address from `connection.json` and the private token. Run **Inspect Spring Security Filter Trace** after making a request to the application. Run it again to refresh.

Each trace shows the chain matchers in the order Spring evaluated them and which chain was selected. It distinguishes configured filters, filters actually entered, and where execution stopped early. The authorization decision is shown when observed. HTTP status is the status when the security proxy returned. [Spring Security servlet architecture](https://docs.spring.io/spring-security/reference/7.1/servlet/architecture.html)

Capture is off by default. The observer retains up to 32 requests in memory, with up to 16 match attempts and 32 configured filters per request. It records the method, timings, framework and filter class names, matcher results, and authorization outcome. It omits request URLs, parameters, headers, cookies, body content, principal identities, and exception text. The trace requires authenticated loopback reads and clears from VS Code when the observer disconnects.

## Method authorization

Set `securityMethodTrace` to `true` alongside `securityTrace` before restarting the application. The request view then adds up to eight observed Spring method decisions and their phase, target signature, authorization manager, and result. For the built-in observation manager, it also shows the delegate that Spring called. Request-filter decisions and method decisions appear in separate sections so that a request allowed by its chain can still show a denied method.

The authority column shows the source of a comparison when Spring's standard authority manager performs one. Role labels are hidden by default. To show a label, add its exact value to the optional `securityTraceRoles` array. You can approve up to twelve labels. The trace reports approved labels actually compared and ones that matched during evaluation. The manager can stop after the first match. The reported labels cover the comparisons reached during that evaluation. It omits expression text, method argument and result values, user identities, and unchecked roles.

The verified version is Spring Security 7.1.2 with synchronous Servlet requests, standard security dispatch, and Spring's before/after method interceptors. Incomplete evidence is marked as partial or unavailable. Reactive WebFlux decisions, asynchronous dispatch, custom filter decorators, and application-wide authority policy are outside this trace scope.

## Authentication providers

Set `authenticationProviderTrace` to `true` and restart the application. This also enables the Servlet filter trace used to associate provider calls with requests. Connect to the local observer, exercise a request, and run **Inspect Spring Authentication Decisions**. Run it again to refresh.

The view shows each observed `ProviderManager` instance and call in request order. It lists the concrete provider classes Spring reached, including providers skipped by `supports`, providers that returned null, and providers that returned a result or raised an exception. Spring can continue after an authentication rejection, so the manager's final outcome appears separately. The table marks the directly observed provider whose result or failure was used.

For a supported parent `ProviderManager` call, the view links the exact nested invocation and shows whether the caller propagated the parent's outcome. It can show a parent that reported no provider and the local provider failure the caller retained. An opaque custom parent can still have an observed call boundary with its own result and propagation status. Its internal provider decisions are unavailable. [Spring Security Servlet authentication architecture](https://docs.spring.io/spring-security/reference/7.1/servlet/authentication/architecture.html)

Observation requires a supported synchronous Servlet request and the verified Spring Security 7.1.2 bytecode shape. The trace retains at most six manager calls and twelve provider steps per manager per request, within the shared 32-request history. The command reads existing evidence. It does not invoke providers or inspect credentials, principal identities, authentication details, exception messages, request payloads, or URLs. Other authentication manager implementations and authentication outside this Servlet dispatch may have no evidence.
