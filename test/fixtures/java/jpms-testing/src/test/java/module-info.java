module fixture.jpms.tests {
    requires fixture.jpms.app;
    requires org.junit.jupiter.api;

    opens fixture.jpms.tests to org.junit.platform.commons;
}
