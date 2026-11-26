# Spring persistence contexts

Prepare the local JPA observer and enable `springPersistenceContexts` in its startup configuration. Restart the Spring application with the agent and connect to that JVM. Run **Inspect Spring Persistence Contexts** to see running context IDs, observed parent links and the JPA factories owned by each context. Context and factory keys distinguish repeated display IDs, persistence-unit names and names such as `entityManagerFactory`.

Ownership follows Spring’s local bean factory at context refresh and the native factory returned by Spring’s container bootstrap. The report shows the effective persistence unit supplied to that factory. Unowned factories and unobserved parents are identified separately. The observer uses the exact framework lifecycle with Spring Framework 7.0.10 and Hibernate ORM 7.4.13. [Spring JPA container bootstrap](https://docs.spring.io/spring-framework/reference/data-access/orm/jpa.html)

For build comparison, list the application packages in `springPersistenceContextPackages` before restarting. The observer records bounded SHA-256 fingerprints of managed application class definitions at class load time. Run **Compare Spring Persistence Build**, choose a persistence unit with complete evidence, then select its compiled classes directory in the workspace. A match applies to the observed managed class bytes. Source buffers, application resources and later transformations outside these startup hooks have separate provenance.

The comparison reads class files and checks the current JVM and factory again before showing its result. Removed units, changed class bytes and incomplete evidence have distinct outcomes. Inspection does not load application entities into a session or issue SQL.
