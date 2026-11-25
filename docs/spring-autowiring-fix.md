# Resolve an ambiguous Spring injection

Open **Quick Fix** from a Rocketbrain Spring ambiguity diagnostic. Choose the candidate bean and review the proposed Java edit in the diff. **Apply Qualifier** inserts one `@Qualifier` annotation at the exact injection declaration.

The tool prefers a unique declared Spring qualifier. It also supports a unique bean name or alias from the current source model. It reanalyzes the edited source to verify that exactly one candidate remains. The review expires if its source, candidate declarations, configuration or active profiles change.

The fix applies to supported Java fields, constructors, initializer parameters and `@Bean` parameters. Unresolved conditions, unknown candidate metadata, existing qualifiers, and optional or unsupported declarations stay outside the edit scope. Settings such as **Spring Base Packages** and **Active Profiles** determine the local model. Dynamic or external registrations require separate runtime evidence.

The paired fixture recompiles the exact proposed Java edit and starts a Spring context with two named beans. The unedited context reports ambiguous injection. Each reviewed alternative selects the intended bean and reads the version of the owned MySQL or MariaDB server.

[Spring qualifier semantics](https://docs.spring.io/spring/reference/7.0/core/beans/annotation-config/autowired-qualifiers.html) · [Spring Bean names and candidate settings](https://docs.spring.io/spring-framework/docs/7.0.x/javadoc-api/org/springframework/context/annotation/Bean.html)
