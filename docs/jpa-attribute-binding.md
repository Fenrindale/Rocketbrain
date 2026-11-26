# Inspect JPA attribute binding

Prepare and connect the local JPA provider observer in a trusted VS Code workspace. Run **Inspect JPA Attribute Binding**, then choose the running factory, managed entity and attribute. Factory IDs distinguish factories that share a display name. Embedded attributes with visible leaf paths can be selected individually.

The report shows the Java attribute type declared by the Jakarta Persistence metamodel beside the effective Hibernate mapping. A supported scalar mapping identifies the physical table and column, domain and relational Java types, JDBC type and code, and the Hibernate binder class. A registered Jakarta attribute converter appears by class name. This allows a domain value object stored as a database integer to be distinguished from an ordinary Java integer attribute.

Inspection reads metadata already held by the selected running factory. It does not open a session, execute SQL, call a value converter or binder, or read data values. The JDBC type describes the selected Hibernate mapping. For types measured on a real application SELECT, open **Inspect Hibernate Fetch Activity** with performance capture enabled.

Spring Boot with Hibernate ORM 7.4 supports the verified scalar and embedded-attribute cases. Partial and unknown results retain the known declaration when available. This includes an embedded object as a whole, custom provider adapters outside the registered contract, absent paths, and closed factories.
