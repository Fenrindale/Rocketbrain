package rocketbrain.observer;

import static rocketbrain.observer.HibernateAccess.invoke;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Dedicated, rollback-only delivery path for the bounded Hibernate console. */
final class ConsoleJdbc {
    private static final int TIMEOUT_SECONDS = 3;
    private static final Set<String> CONNECTION_QUERIES = Set.of("getAutoCommit","getTransactionIsolation","getWarnings",
        "clearWarnings","isClosed","getCatalog","getSchema","isReadOnly");
    private static final Set<String> STATEMENT_OPERATIONS = Set.of("close","isClosed","cancel","getWarnings","clearWarnings",
        "getQueryTimeout","setQueryTimeout","setFetchSize","setMaxRows","getMaxRows","getResultSet","getUpdateCount","executeQuery",
        "setNull","setObject","setString","setNString","setBoolean","setByte","setShort","setInt","setLong","setDouble","setFloat",
        "setBigDecimal","setDate","setTime","setTimestamp","setBytes","clearParameters");

    private ConsoleJdbc() {}

    static Map<String,Object> select(Object factory,ConsoleQuery.Prepared prepared,List<ConsoleQuery.Bound> bindings,int limit) throws Throwable {
        Object options = invoke(factory,"getSessionFactoryOptions");
        if (!Boolean.FALSE.equals(invoke(options,"isMultiTenancyEnabled"))) throw new ConsoleQuery.Refusal("unsupported_factory_scope");
        Object jdbc = invoke(factory,"getJdbcServices");
        String dialect = invoke(jdbc,"getDialect").getClass().getName();
        if (!Set.of("org.hibernate.dialect.MySQLDialect","org.hibernate.dialect.MariaDBDialect").contains(dialect))
            throw new ConsoleQuery.Refusal("unsupported_database");
        Object access = invoke(jdbc,"getBootstrapJdbcConnectionAccess");
        Connection connection = (Connection)invoke(access,"obtainConnection");
        List<?> selected;
        boolean touched = false, disposable = false;
        try {
            String product = connection.getMetaData().getDatabaseProductName();
            if (!Set.of("MySQL","MariaDB").contains(product) || !connection.getAutoCommit())
                throw new ConsoleQuery.Refusal("unsupported_connection_scope");
            touched = true;
            connection.setAutoCommit(false);
            try (Statement begin = connection.createStatement()) {
                begin.setQueryTimeout(TIMEOUT_SECONDS);
                begin.execute("START TRANSACTION READ ONLY");
            }
            Gate gate = new Gate(connection);
            Object builder = invoke(factory,"withOptions");
            invoke(builder,"connection",gate.view());
            invoke(builder,"noStatementInspector");
            invoke(builder,"noInterceptor");
            invoke(builder,"clearEventListeners");
            try (AutoCloseable session = (AutoCloseable)invoke(builder,"openSession")) {
                ClassLoader loader = factory.getClass().getClassLoader();
                invoke(session,"setHibernateFlushMode",enumValue(loader,"org.hibernate.FlushMode","MANUAL"));
                invoke(session,"setCacheMode",enumValue(loader,"org.hibernate.CacheMode","IGNORE"));
                invoke(session,"setDefaultReadOnly",true);
                Object query = invoke(session,"createSelectionQuery",prepared.query());
                invoke(query,"setReadOnly",true);
                invoke(query,"setTimeout",TIMEOUT_SECONDS);
                invoke(query,"setCacheable",false);
                invoke(query,"setMaxResults",limit+1);
                for (ConsoleQuery.Bound binding : bindings)
                    invoke(query,"setParameter",binding.parameter().selector(),binding.value(),binding.javaType());
                selected = (List<?>)invoke(query,"getResultList");
                if (!gate.executed) throw new ConsoleQuery.Refusal("database_execution_unconfirmed");
            }
        } finally {
            try {
                if (touched) { connection.rollback(); connection.setAutoCommit(true); }
            } catch (Throwable cleanup) {
                disposable = true;
                try { connection.abort(Runnable::run); } catch (Throwable abort) { cleanup.addSuppressed(abort); }
                throw cleanup;
            } finally {
                if (!disposable) invoke(access,"releaseConnection",connection);
                else connection.close();
            }
        }
        return ConsoleQuery.rows(prepared,selected,limit);
    }

    private static Object enumValue(ClassLoader loader,String type,String value) throws ReflectiveOperationException {
        return Class.forName(type,false,loader).getField(value).get(null);
    }

    private static Object forward(Object target,Method method,Object[] arguments) throws Throwable {
        try { return method.invoke(target,arguments); }
        catch (InvocationTargetException error) { throw error.getCause(); }
    }

    private static final class Gate {
        private final Connection connection;
        private boolean prepared, executed;
        Gate(Connection connection) { this.connection = connection; }

        Connection view() {
            return (Connection)Proxy.newProxyInstance(Connection.class.getClassLoader(),new Class<?>[]{Connection.class},
                (proxy,method,args)-> {
                    String name = method.getName();
                    if (name.equals("close")) return null;
                    if (CONNECTION_QUERIES.contains(name)) return forward(connection,method,args);
                    if (method.getDeclaringClass()==Object.class) return identity(proxy,name,args);
                    boolean forwardOnly = args!=null && (args.length==1 || args.length==3 &&
                        Integer.valueOf(ResultSet.TYPE_FORWARD_ONLY).equals(args[1]) && Integer.valueOf(ResultSet.CONCUR_READ_ONLY).equals(args[2]));
                    if (!name.equals("prepareStatement") || prepared || !forwardOnly || !(args[0] instanceof String sql))
                        throw new SQLFeatureNotSupportedException("Operation blocked by JPQL console connection");
                    ConsoleQuery.inspect(sql,true);
                    prepared = true;
                    return statement(connection.prepareStatement(sql));
                });
        }

        private PreparedStatement statement(PreparedStatement nativeStatement) {
            return (PreparedStatement)Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(),new Class<?>[]{PreparedStatement.class},
                (proxy,method,args)-> {
                    String name = method.getName();
                    if (method.getDeclaringClass()==Object.class) return identity(proxy,name,args);
                    if (!STATEMENT_OPERATIONS.contains(name)) throw new SQLFeatureNotSupportedException("Operation blocked by JPQL console statement");
                    if (name.equals("setQueryTimeout")) {
                        nativeStatement.setQueryTimeout(TIMEOUT_SECONDS);
                        return null;
                    }
                    if (name.equals("executeQuery")) {
                        if (executed || args!=null && args.length>0) throw new SQLFeatureNotSupportedException("Only one prepared SELECT is allowed");
                        nativeStatement.setQueryTimeout(TIMEOUT_SECONDS);
                        Object result = forward(nativeStatement,method,args);
                        executed = true;
                        return result;
                    }
                    return forward(nativeStatement,method,args);
                });
        }

        private static Object identity(Object proxy,String name,Object[] args) {
            return switch(name) {
                case "equals" -> proxy == args[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> "Rocketbrain JPQL console JDBC view";
            };
        }
    }
}
