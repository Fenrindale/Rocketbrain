module fixture.jpms.tests {
    requires fixture.jpms.app;
    requires org.testng;

    opens fixture.jpms.tests to org.testng;
}
