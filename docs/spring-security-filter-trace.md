# Spring Security filter trace

Use **Prepare Local JVM Observer** with an independent JDK 25 or newer. Set `securityTrace` to `true` in the generated configuration and restart the application with the provided JVM arguments. Use **Connect Local JVM Observer** with the loopback address from `connection.json` and the private token. Run **Inspect Spring Security Filter Trace** after making a request to the application. Run it again to refresh.

Each trace shows the chain matchers in the order Spring evaluated them and which chain was selected. It distinguishes configured filters, filters actually entered, and where execution stopped early. The authorization decision is shown when observed. HTTP status is the status when the security proxy returned. [Spring Security servlet architecture](https://docs.spring.io/spring-security/reference/7.1/servlet/architecture.html)

Capture is off by default. The observer retains up to 32 requests in memory, with up to 16 match attempts and 32 configured filters per request. It records the method, timings, framework and filter class names, matcher results, and authorization outcome. It discards request URLs, parameters, headers, cookies, body content, principals, authorities, and exception text. The trace requires authenticated loopback reads and clears from VS Code when the observer disconnects.

The verified version is Spring Security 7.1.2 with synchronous servlet requests and the standard security filter dispatch. Requests with incomplete evidence are marked as partial. Reactive chains, asynchronous dispatch, custom decorators, and application-wide authority policy are outside this trace scope.
