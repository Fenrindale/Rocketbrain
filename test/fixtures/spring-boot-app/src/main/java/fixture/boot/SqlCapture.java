package fixture.boot;
import java.util.List;
import java.util.ArrayDeque;
import org.hibernate.resource.jdbc.spi.StatementInspector;
public class SqlCapture implements StatementInspector {
    private static final ArrayDeque<String> STATEMENTS = new ArrayDeque<>();
    @Override public String inspect(String sql) {
        synchronized (STATEMENTS) {
            if (STATEMENTS.size() >= 100) STATEMENTS.removeFirst();
            STATEMENTS.addLast(sql);
        }
        return sql;
    }
    public static List<String> snapshot() { synchronized(STATEMENTS) { return List.copyOf(STATEMENTS); } }
}
