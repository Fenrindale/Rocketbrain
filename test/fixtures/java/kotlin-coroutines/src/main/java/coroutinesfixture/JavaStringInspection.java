package coroutinesfixture;

import java.io.BufferedReader;
import java.io.InputStreamReader;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

public final class JavaStringInspection {
    public static void main(String[] args) throws Exception {
        if (args.length == 1) waitForInspection();
        paused(new String(latin()), new String(wide()), new String(wide()), "short value");
    }

    public static String latin() { return "A\0\u00E9\u00FF".repeat(68003) + "tail"; }

    public static String wide() {
        return "\uD55C".repeat(8191) + "\uD83D\uDE00" + "ab\uD800\uB05D\uDC00".repeat(53000) + "\r\nlast";
    }

    public static void waitForInspection() throws Exception {
        System.out.println("Rocketbrain coroutine fixture ready");
        if (!"inspect".equals(new BufferedReader(new InputStreamReader(System.in)).readLine())) {
            throw new IllegalStateException("Fixture inspection was not requested.");
        }
    }

    private static void paused(String latin, String wide, String other, String shortValue) {
        verifyAndRead(latin, wide, other, shortValue, "java");
    }

    public static void verifyAndRead(String latin, String wide, String other, String shortValue, String language) {
        if (!latin().equals(latin) || !wide().equals(wide) || !wide.equals(other) || other == wide || !"short value".equals(shortValue)) {
            throw new IllegalStateException("Paused String values changed.");
        }
        JdbcTemplate jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_COROUTINE_JDBC_URL"),
            System.getenv("RB_COROUTINE_JDBC_USER"), System.getenv("RB_COROUTINE_JDBC_PASSWORD")));
        String version = jdbc.queryForObject("SELECT VERSION()", String.class);
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);
        System.out.println("Rocketbrain String JDBC|" + language + "|" + version + "|" + count);
    }
}
