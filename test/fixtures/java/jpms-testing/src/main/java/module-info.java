module fixture.jpms.app {
    requires java.sql;
    requires org.apache.commons.logging;
    requires spring.jdbc;
    exports fixture.jpms.app;
}
