package fixture.jdbc;

import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.Properties;
import java.util.logging.Logger;

/** Test-only driver. The vendor implementation must be in an explicitly listed JAR. */
public final class FixtureDriver implements Driver {
    private final Driver delegate;

    public FixtureDriver() throws ReflectiveOperationException {
        delegate = Class.forName("org.mariadb.jdbc.Driver", true, getClass().getClassLoader())
            .asSubclass(Driver.class).getConstructor().newInstance();
    }

    @Override public Connection connect(String url, Properties properties) throws SQLException { return delegate.connect(url, properties); }

    @Override public boolean acceptsURL(String url) throws SQLException { return delegate.acceptsURL(url); }

    @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties properties) throws SQLException {
        return delegate.getPropertyInfo(url, properties);
    }

    @Override public int getMajorVersion() { return delegate.getMajorVersion(); }
    @Override public int getMinorVersion() { return delegate.getMinorVersion(); }
    @Override public boolean jdbcCompliant() { return delegate.jdbcCompliant(); }
    @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException { return delegate.getParentLogger(); }
}
