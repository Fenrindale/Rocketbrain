import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.Reader;
import java.net.URL;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.CodeSource;
import java.security.MessageDigest;
import java.security.SecureClassLoader;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.Base64;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HexFormat;
import java.util.Locale;
import java.util.List;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicReference;
import java.util.jar.JarFile;

class DriverWorker {
    private static final int CELL_BYTES = 64 * 1024;
    private static final int MAX_COLUMNS = 128;
    private static final String PROTOCOL = "RBJDBC1";
    private static final PrintStream WIRE = System.out;
    private static final AtomicReference<Statement> ACTIVE = new AtomicReference<>();
    private static boolean cancelled = false;

    static final class DriverLoader extends SecureClassLoader implements AutoCloseable {
        private record Archive(URL source, JarFile file) { }
        private final List<Archive> archives = new ArrayList<>();

        DriverLoader(List<Path> paths) throws Exception {
            super(ClassLoader.getPlatformClassLoader());
            try {
                for (Path path : paths) archives.add(new Archive(path.toUri().toURL(),
                    new JarFile(path.toFile(), true, JarFile.OPEN_READ, Runtime.version())));
            } catch (Exception failure) {
                close();
                throw failure;
            }
        }

        boolean declaresDriver(String name) {
            return archives.getFirst().file().getJarEntry(name.replace('.', '/') + ".class") != null;
        }

        @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
            for (Archive archive : archives) {
                var entry = archive.file().getJarEntry(name.replace('.', '/') + ".class");
                if (entry == null) continue;
                if (entry.getSize() > 16L * 1024 * 1024) throw new ClassNotFoundException(name);
                try (var stream = archive.file().getInputStream(entry)) {
                    byte[] bytes = stream.readNBytes(16 * 1024 * 1024 + 1);
                    if (bytes.length != entry.getSize()) throw new ClassNotFoundException(name);
                    return defineClass(name, bytes, 0, bytes.length, new CodeSource(archive.source(), entry.getCodeSigners()));
                } catch (java.io.IOException error) { throw new ClassNotFoundException(name, error); }
            }
            throw new ClassNotFoundException(name);
        }

        private URL resource(Archive archive, String name) {
            var entry = archive.file().getJarEntry(name);
            if (entry == null) return null;
            try {
                String entryPath = new URI(null, null, "/" + entry.getRealName(), null).getRawPath();
                return URI.create("jar:" + archive.source().toExternalForm() + "!" + entryPath).toURL();
            } catch (Exception ignored) { return null; }
        }

        @Override protected URL findResource(String name) {
            for (Archive archive : archives) {
                URL found = resource(archive, name);
                if (found != null) return found;
            }
            return null;
        }

        @Override protected Enumeration<URL> findResources(String name) {
            List<URL> found = new ArrayList<>();
            for (Archive archive : archives) {
                URL location = resource(archive, name);
                if (location != null) found.add(location);
            }
            return Collections.enumeration(found);
        }

        @Override public void close() throws java.io.IOException {
            java.io.IOException failure = null;
            for (Archive archive : archives) {
                try { archive.file().close(); }
                catch (java.io.IOException error) { failure = error; }
            }
            if (failure != null) throw failure;
        }
    }

    static void emit(String tag, String... fields) throws Exception {
        var row = new StringBuilder(PROTOCOL).append('\t').append(tag);
        for (String field : fields) {
            row.append('\t');
            if (field == null) {
                row.append('-');
            } else {
                byte[] data = field.getBytes(StandardCharsets.UTF_8);
                if (data.length > CELL_BYTES) throw new SQLException("Output cell limit", "RB001");
                row.append(Base64.getEncoder().encodeToString(data));
            }
        }
        WIRE.println(row);
    }

    static String input(BufferedReader reader) throws Exception {
        String line = reader.readLine();
        if (line == null || line.length() > 176000) throw new Exception("Protocol input invalid");
        return new String(Base64.getDecoder().decode(line), StandardCharsets.UTF_8);
    }

    static void observeCancel(BufferedReader in) {
        Thread reader = new Thread(() -> {
            try {
                if ("CANCEL".equals(in.readLine())) {
                    Statement statement;
                    synchronized (ACTIVE) {
                        cancelled = true;
                        statement = ACTIVE.get();
                    }
                    if (statement != null) statement.cancel();
                }
            } catch (Exception ignored) {
                // The process owner closes the child after its cancellation grace period.
            }
        });
        reader.setDaemon(true);
        reader.start();
    }

    static void verifyJar(Path file, String expected) throws Exception {
        if (Files.size(file) > 64L * 1024 * 1024) throw new SQLException("JAR limit", "RB002");
        var digest = MessageDigest.getInstance("SHA-256");
        try (var stream = new DigestInputStream(Files.newInputStream(file), digest)) {
            stream.transferTo(OutputStream.nullOutputStream());
        }
        if (!HexFormat.of().formatHex(digest.digest()).equals(expected)) throw new SQLException("JAR changed", "RB002");
    }

    static boolean isPostgres(DatabaseMetaData metadata) throws Exception {
        return "postgresql".equals(metadata.getDatabaseProductName().toLowerCase(Locale.ROOT));
    }

    static void readOnly(Connection connection, DatabaseMetaData metadata) throws Exception {
        String product = metadata.getDatabaseProductName().toLowerCase(Locale.ROOT);
        connection.setReadOnly(true);
        if (isPostgres(metadata)) {
            try (Statement statement = connection.createStatement()) {
                statement.setQueryTimeout(5);
                statement.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
                statement.execute("SET standard_conforming_strings = on");
                connection.setAutoCommit(false);
                try (ResultSet setting = statement.executeQuery("SHOW transaction_read_only")) {
                    if (!setting.next() || !"on".equals(setting.getString(1))) throw new SQLException("PostgreSQL read only required", "RB003");
                }
            }
            return;
        } else if (product.contains("mysql") || product.contains("mariadb")) {
            try (Statement statement = connection.createStatement()) {
                statement.setQueryTimeout(5);
                statement.execute("SET SESSION TRANSACTION READ ONLY");
            }
        } else if (!connection.isReadOnly()) {
            throw new SQLException("The driver did not accept a read-only connection", "RB003");
        }
        connection.setAutoCommit(false);
    }

    static void catalog(Connection connection, DatabaseMetaData metadata) throws Exception {
        String catalog = connection.getCatalog(), schema = connection.getSchema();
        emit("I", metadata.getDatabaseProductName(), metadata.getDatabaseProductVersion(), metadata.getDriverName(),
            metadata.getDriverVersion(), catalog, schema);
        int rows = 0;
        boolean postgres = isPostgres(metadata);
        String[] types = postgres ? new String[]{"TABLE", "BASE TABLE", "VIEW", "MATERIALIZED VIEW", "PARTITIONED TABLE"}
            : new String[]{"TABLE", "BASE TABLE", "VIEW"};
        try (ResultSet tables = metadata.getTables(catalog, schema, "%", types)) {
            while (tables.next()) {
                if (postgres && !nullText(schema).equals(nullText(tables.getString("TABLE_SCHEM")))) continue;
                if (++rows > 500) break;
                emit("T", tables.getString("TABLE_CAT"), tables.getString("TABLE_SCHEM"), tables.getString("TABLE_NAME"), tables.getString("TABLE_TYPE"));
            }
        }
        emit("D", Boolean.toString(rows > 500));
    }

    static String exactPattern(String escape, String text) {
        if (text.isEmpty()) return null;
        if (escape == null || escape.isEmpty()) return text;
        return text.replace(escape, escape + escape).replace("%", escape + "%").replace("_", escape + "_");
    }

    static String nullText(String text) { return text == null ? "" : text; }

    static void describe(DatabaseMetaData metadata, String catalog, String schema, String object) throws Exception {
        int rows = 0;
        String escape = metadata.getSearchStringEscape();
        try (ResultSet columns = metadata.getColumns(catalog.isEmpty() ? null : catalog,
                exactPattern(escape, schema), exactPattern(escape, object), "%")) {
            while (columns.next()) {
                if (!object.equals(columns.getString("TABLE_NAME")) || !catalog.equals(nullText(columns.getString("TABLE_CAT"))) ||
                        !schema.equals(nullText(columns.getString("TABLE_SCHEM")))) continue;
                if (++rows > 250) break;
                emit("C", columns.getString("COLUMN_NAME"), columns.getString("DATA_TYPE"), columns.getString("TYPE_NAME"),
                    columns.getString("IS_NULLABLE"), columns.getString("COLUMN_SIZE"), columns.getString("DECIMAL_DIGITS"));
            }
        }
        emit("D", Boolean.toString(rows > 250));
    }

    static String readText(ResultSet result, int position) throws Exception {
        try (Reader reader = result.getCharacterStream(position)) {
            if (reader == null) return null;
            char[] buffer = new char[2048];
            var value = new StringBuilder();
            int count;
            while ((count = reader.read(buffer)) != -1) {
                if (value.length() + count > CELL_BYTES) throw new SQLException("Text cell limit", "RB001");
                value.append(buffer, 0, count);
            }
            return value.toString();
        }
    }

    static String cell(ResultSet result, int position, int type) throws Exception {
        switch (type) {
            case Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY, Types.BLOB -> {
                try (var stream = result.getBinaryStream(position)) {
                    if (stream == null) return null;
                    byte[] bytes = stream.readNBytes(CELL_BYTES / 2);
                    if (bytes.length >= CELL_BYTES / 2) throw new SQLException("Binary cell limit", "RB001");
                    return "0x" + HexFormat.of().formatHex(bytes);
                }
            }
            case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR, Types.NCHAR, Types.NVARCHAR, Types.LONGNVARCHAR, Types.CLOB, Types.NCLOB -> {
                return readText(result, position);
            }
            default -> {
                return result.getString(position);
            }
        }
    }

    static void query(Connection connection, DatabaseMetaData metadata, String sql, int maxRows) throws Exception {
        readOnly(connection, metadata);
        try (Statement statement = isPostgres(metadata) ? connection.createStatement() : connection.prepareStatement(sql)) {
            statement.setQueryTimeout(8);
            statement.setMaxRows(maxRows + 1);
            synchronized (ACTIVE) {
                if (cancelled) throw new SQLException("Cancelled", "57014");
                ACTIVE.set(statement);
            }
            try (var result = statement instanceof PreparedStatement prepared ? prepared.executeQuery() : statement.executeQuery(sql)) {
                ResultSetMetaData columns = result.getMetaData();
                int width = columns.getColumnCount();
                if (width < 1 || width > MAX_COLUMNS) throw new SQLException("Column limit", "RB001");
                var types = new int[width];
                for (int i = 0; i < width; i++) {
                    int position = i + 1;
                    types[i] = columns.getColumnType(position);
                    emit("C", columns.getColumnLabel(position), String.valueOf(types[i]), columns.getColumnTypeName(position),
                        String.valueOf(columns.isNullable(position)), String.valueOf(columns.getPrecision(position)),
                        String.valueOf(columns.getScale(position)));
                }
                int rows = 0;
                while (result.next()) {
                    if (++rows > maxRows) break;
                    String[] values = new String[width];
                    for (int i = 0; i < width; i++) values[i] = cell(result, i + 1, types[i]);
                    emit("R", values);
                }
                emit("D", Boolean.toString(rows > maxRows));
            } finally { ACTIVE.set(null); }
        } finally { connection.rollback(); }
    }

    private static SQLException planScope() {
        return new SQLException("Unsupported PostgreSQL plan scope", "RB006");
    }

    private static String planIdentifier(String value) throws SQLException {
        if (!value.matches("[a-z_][a-z0-9_]{0,62}")) throw planScope();
        return "\"" + value + "\"";
    }

    private static String planRelation(Connection connection, String schema, String table) throws Exception {
        String sql = """
            SELECT c.oid::text
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_catalog.pg_am am ON am.oid=c.relam
            WHERE n.nspname=? AND c.relname=? AND c.relkind='r' AND c.relpersistence='p'
              AND am.amname='heap' AND NOT c.relrowsecurity AND NOT c.relhasrules AND NOT c.relispartition
              AND pg_catalog.has_table_privilege(c.oid,'SELECT')
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE c.oid IN (i.inhrelid,i.inhparent))
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='c')
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_statistic_ext s WHERE s.stxrelid=c.oid AND s.stxexprs IS NOT NULL)
              AND NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
                JOIN pg_catalog.pg_am ia ON ia.oid=ic.relam
                WHERE i.indrelid=c.oid AND (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL OR ia.amname<>'btree'
                  OR EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indclass::oid[]) k(oid)
                    JOIN pg_catalog.pg_opclass o ON o.oid=k.oid
                    WHERE o.opcnamespace<>'pg_catalog'::regnamespace OR o.oid>=16384)))
            """;
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(5);
            statement.setString(1, schema);
            statement.setString(2, table);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) throw planScope();
                return result.getString(1);
            }
        }
    }

    private static Map<String, String> planColumns(Connection connection, String relation) throws Exception {
        var columns = new HashMap<String, String>();
        try (PreparedStatement statement = connection.prepareStatement("""
            SELECT a.attname, CASE WHEN t.typnamespace='pg_catalog'::regnamespace AND t.typtype='b'
              AND t.oid<16384 AND a.attgenerated='' THEN t.typname END
            FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
            WHERE a.attrelid=?::pg_catalog.oid AND a.attnum>0 AND NOT a.attisdropped
            """)) {
            statement.setQueryTimeout(5);
            statement.setString(1, relation);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) columns.put(result.getString(1), result.getString(2));
            }
        }
        return columns;
    }

    private static String planFingerprint(Connection connection, String relation, String query, String predicate) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement("""
            SELECT pg_catalog.jsonb_build_array(
              pg_catalog.current_database(), SESSION_USER, CURRENT_USER, pg_catalog.pg_postmaster_start_time(),
              r.oid, r.relnamespace, r.relfilenode, r.relowner, r.relacl, r.reloptions, r.reltablespace,
              (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attnum,a.attname,a.atttypid,a.atttypmod,
                  a.attcollation,a.attnotnull,a.attgenerated,a.attacl) ORDER BY a.attnum)
                FROM pg_catalog.pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
              (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(i.indexrelid,x.relname,x.relfilenode,x.relam,
                  i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indkey,i.indclass,i.indcollation,i.indoption)
                  ORDER BY i.indexrelid)
                FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
                WHERE i.indrelid=r.oid))::text
            FROM pg_catalog.pg_class r WHERE r.oid=?::pg_catalog.oid
            """)) {
            statement.setQueryTimeout(5);
            statement.setString(1, relation);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) throw planScope();
                String observed = readText(result, 1);
                if (observed == null || result.next()) throw planScope();
                return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest((observed + "\n" + query + "\n" + predicate).getBytes(StandardCharsets.UTF_8)));
            }
        }
    }

    private static void lockPlanRelation(Statement setup, String qualified, boolean reviewed) throws SQLException {
        try {
            setup.execute("LOCK TABLE ONLY " + qualified + " IN " +
                (reviewed ? "SHARE UPDATE EXCLUSIVE" : "ACCESS SHARE") + " MODE NOWAIT");
        } catch (SQLException error) {
            if (reviewed && "42501".equals(error.getSQLState())) throw new SQLException("Measuring requires PostgreSQL MAINTAIN", "RB010");
            if (reviewed && "55P03".equals(error.getSQLState())) throw new SQLException("PostgreSQL relation is busy", "RB011");
            throw error;
        }
    }

    private static void postgresPlan(Connection connection, DatabaseMetaData metadata, String expectedSchema,
            String schema, String table, String project, String payload, String operation) throws Exception {
        boolean reviewed = !"plan".equals(operation), measured = "plan-measure".equals(operation);
        if (!isPostgres(metadata) || metadata.getDatabaseMajorVersion() < (reviewed ? 17 : 14) || !schema.equals(expectedSchema) ||
                schema.startsWith("pg_") || schema.equals("information_schema")) throw planScope();
        String[] approval = measured ? payload.split("\\t", -1) : new String[0];
        if (measured && (approval.length != 3 || !approval[0].matches("[a-f0-9]{64}") || !approval[1].matches("[0-9]{1,10}"))) {
            throw new SQLException("Invalid PostgreSQL plan review", "RB009");
        }
        String predicate = measured ? approval[2] : payload;
        String qualified = planIdentifier(schema) + "." + planIdentifier(table);
        var names = List.of(project.split(",", -1));
        boolean all = names.equals(List.of("*"));
        if (names.size() > 32 || new HashSet<>(names).size() != names.size()) throw planScope();
        var projections = new ArrayList<String>();
        if (!all) for (String name : names) projections.add(planIdentifier(name));
        String[] filter = predicate.isEmpty() ? new String[0] : predicate.split("=", -1);
        if (filter.length != 0 && (filter.length != 2 || !filter[1].matches("-?[0-9]{1,19}"))) throw planScope();
        String filterName = filter.length == 2 ? planIdentifier(filter[0]) : "";

        readOnly(connection, metadata);
        try (Statement setup = connection.createStatement()) {
            setup.setQueryTimeout(5);
            setup.execute("SET LOCAL search_path=pg_catalog,pg_temp");
            setup.execute("SET LOCAL row_security=off");
            setup.execute("SET LOCAL constraint_exclusion=off");
            if (reviewed) {
                setup.execute("SET LOCAL statement_timeout='8s'");
                setup.execute("SET LOCAL lock_timeout='1s'");
                setup.execute("SET LOCAL idle_in_transaction_session_timeout='10s'");
                setup.execute("SET LOCAL application_name='Rocketbrain PostgreSQL Plan'");
            }
            String relation = planRelation(connection, schema, table);
            lockPlanRelation(setup, qualified, reviewed);
            if (!relation.equals(planRelation(connection, schema, table)) || measured && !relation.equals(approval[1])) {
                if (measured) throw new SQLException("PostgreSQL plan relation changed", "RB009");
                throw planScope();
            }
            final var columns = planColumns(connection, relation);
            if (all ? columns.isEmpty() || columns.containsValue(null) : names.stream().anyMatch(name -> columns.get(name) == null)) {
                throw planScope();
            }
            if (reviewed && (columns.size() > 128 || columns.containsValue(null))) throw planScope();
            String type = filter.length == 2 ? columns.get(filter[0]) : "";
            if (filter.length == 2 && (type == null || !List.of("int2", "int4", "int8").contains(type))) throw planScope();
            String query = "SELECT " +
                (all ? "*" : String.join(", ", projections)) + " FROM ONLY " + qualified +
                (filter.length == 2 ? " WHERE " + filterName + " OPERATOR(pg_catalog.=) ?::pg_catalog." + type : "");
            String fingerprint = reviewed ? planFingerprint(connection, relation, query, predicate) : "";
            if (measured && !fingerprint.equals(approval[0])) throw new SQLException("PostgreSQL plan evidence changed", "RB009");
            String sql = (measured ? "EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, TIMING TRUE, SUMMARY TRUE, VERBOSE TRUE, COSTS TRUE, FORMAT JSON) " :
                "EXPLAIN (ANALYZE FALSE, VERBOSE TRUE, COSTS TRUE, FORMAT JSON) ") + query;
            String document;
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                statement.setQueryTimeout(8);
                if (filter.length == 2) {
                    try {
                        switch (type) {
                            case "int2" -> statement.setShort(1, Short.parseShort(filter[1]));
                            case "int4" -> statement.setInt(1, Integer.parseInt(filter[1]));
                            case "int8" -> statement.setLong(1, Long.parseLong(filter[1]));
                        }
                    } catch (NumberFormatException invalid) { throw planScope(); }
                }
                synchronized (ACTIVE) {
                    if (cancelled) throw new SQLException("Cancelled", "57014");
                    ACTIVE.set(statement);
                }
                try (ResultSet result = statement.executeQuery()) {
                    if (!result.next()) throw planScope();
                    document = readText(result, 1);
                    if (document == null || result.next()) throw planScope();
                } finally { ACTIVE.set(null); }
            }
            if (!relation.equals(planRelation(connection, schema, table))) throw planScope();
            if (reviewed) {
                if (!fingerprint.equals(planFingerprint(connection, relation, query, predicate))) {
                    throw new SQLException("PostgreSQL plan evidence changed", "RB009");
                }
                emit("P", metadata.getDatabaseProductVersion(), relation, fingerprint, query, document);
            } else emit("P", metadata.getDatabaseProductVersion(), relation, document);
        } finally { connection.rollback(); }
    }

    private static final class PostgresGrid {
        private record Field(String name, String type, boolean nullable, int number, int typeModifier) { }
        private record Grid(String relation, List<Field> fields) { }
        private static final List<String> INTEGERS = List.of("int2", "int4", "int8");
        private static final int ROWS = 100;

        private static SQLException scope() { return new SQLException("Unsupported PostgreSQL grid scope", "RB007"); }
        private static SQLException stale() { return new SQLException("PostgreSQL grid snapshot changed", "RB008"); }

        private static Grid inspect(Connection connection, String schema, String table) throws Exception {
            String relation;
            try { relation = planRelation(connection, schema, table); }
            catch (SQLException error) {
                if ("RB006".equals(error.getSQLState())) throw scope();
                throw error;
            }
            try (PreparedStatement guard = connection.prepareStatement("""
                SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=r.oid)
                  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=r.oid AND NOT a.attisdropped AND a.attgenerated<>'')
                FROM pg_catalog.pg_class r WHERE r.oid=?::pg_catalog.oid
                """)) {
                guard.setQueryTimeout(5);
                guard.setString(1, relation);
                try (ResultSet result = guard.executeQuery()) {
                    if (!result.next() || !result.getBoolean(1)) throw scope();
                }
            }

            String primary;
            try (PreparedStatement key = connection.prepareStatement("""
                SELECT a.attname FROM pg_catalog.pg_index i
                JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
                WHERE i.indrelid=?::pg_catalog.oid AND i.indisprimary AND i.indisvalid
                  AND i.indnkeyatts=1 AND i.indimmediate AND a.attnotnull
                """)) {
                key.setQueryTimeout(5);
                key.setString(1, relation);
                try (ResultSet result = key.executeQuery()) {
                    if (!result.next()) throw scope();
                    primary = result.getString(1);
                }
            }

            Field identity = null;
            var fields = new ArrayList<Field>();
            try (PreparedStatement columns = connection.prepareStatement("""
                SELECT a.attname,t.typname,NOT a.attnotnull,a.attidentity,a.attnum,a.atttypmod
                FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
                WHERE a.attrelid=?::pg_catalog.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
                  AND t.typnamespace='pg_catalog'::regnamespace AND t.oid<16384 AND t.typtype='b'
                  AND t.typname IN ('int2','int4','int8','text','varchar')
                ORDER BY a.attnum
                """)) {
                columns.setQueryTimeout(5);
                columns.setString(1, relation);
                try (ResultSet result = columns.executeQuery()) {
                    while (result.next()) {
                        String name = result.getString(1), type = result.getString(2);
                        if (!name.matches("[a-z_][a-z0-9_]{0,62}")) continue;
                        var field = new Field(name, type, result.getBoolean(3), result.getInt(5), result.getInt(6));
                        if (name.equals(primary) && INTEGERS.contains(type)) identity = field;
                        else if (!name.equals(primary) && result.getString(4).isEmpty()) fields.add(field);
                    }
                }
            }
            if (identity == null || fields.isEmpty() || fields.size() > 31) throw scope();
            fields.addFirst(identity);
            return new Grid(relation, fields);
        }

        private static void configure(Statement statement) throws SQLException {
            statement.setQueryTimeout(5);
            statement.execute("SET LOCAL search_path=pg_catalog,pg_temp");
            statement.execute("SET LOCAL row_security=off");
            statement.execute("SET LOCAL constraint_exclusion=off");
        }

        private static void activate(Statement statement) throws SQLException {
            synchronized (ACTIVE) {
                if (cancelled) throw new SQLException("Cancelled", "57014");
                ACTIVE.set(statement);
            }
        }

        private static void read(Connection connection, DatabaseMetaData metadata, String schema, String table,
                String qualified) throws Exception {
            readOnly(connection, metadata);
            try (Statement statement = connection.createStatement()) {
                configure(statement);
                Grid before = inspect(connection, schema, table);
                statement.execute("LOCK TABLE ONLY " + qualified + " IN ACCESS SHARE MODE NOWAIT");
                Grid grid = inspect(connection, schema, table);
                if (!before.equals(grid)) throw stale();
                var projection = new ArrayList<String>();
                for (Field field : grid.fields()) projection.add(planIdentifier(field.name()));
                emit("G", grid.relation());
                for (Field field : grid.fields()) emit("F", field.name(), field.type(), Boolean.toString(field.nullable()),
                    Integer.toString(field.number()), Integer.toString(field.typeModifier()));
                activate(statement);
                try (ResultSet result = statement.executeQuery("SELECT xmin::pg_catalog.text, " + String.join(", ", projection) +
                        " FROM ONLY " + qualified + " ORDER BY " + projection.getFirst() + " LIMIT " + (ROWS + 1))) {
                    int rows = 0;
                    while (result.next()) {
                        if (++rows > ROWS) break;
                        String[] values = new String[grid.fields().size() + 1];
                        for (int i = 0; i < values.length; i++) values[i] = readText(result, i + 1);
                        emit("R", values);
                    }
                    emit("D", Boolean.toString(rows > ROWS));
                } finally { ACTIVE.set(null); }
                if (!grid.equals(inspect(connection, schema, table))) throw stale();
            } finally { connection.rollback(); }
        }

        private static String nullable(String present, String value) throws SQLException {
            if ("1".equals(present) && value.getBytes(StandardCharsets.UTF_8).length <= 8192) return value;
            if ("0".equals(present) && value.isEmpty()) return null;
            throw scope();
        }

        private static void update(Connection connection, String schema, String table, String qualified,
                String fieldName, String encoded) throws Exception {
            String[] review = encoded.split("\\x00", -1);
            if (review.length != 14 || !review[0].matches("[0-9]{1,10}") || !review[1].matches("[0-9]{1,10}")) throw scope();
            String original = nullable(review[7], review[8]), replacement = nullable(review[9], review[10]);
            if (Objects.equals(original, replacement)) throw scope();
            connection.setAutoCommit(false);
            boolean committed = false;
            try (Statement setup = connection.createStatement()) {
                configure(setup);
                try (ResultSet setting = setup.executeQuery("SHOW transaction_read_only")) {
                    if (!setting.next() || !"off".equals(setting.getString(1))) throw scope();
                }
                // SHARE ROW EXCLUSIVE blocks writers, schema changes and concurrent index builds while the reviewed row is checked.
                setup.execute("LOCK TABLE ONLY " + qualified + " IN SHARE ROW EXCLUSIVE MODE NOWAIT");
                Grid grid = inspect(connection, schema, table);
                Field identity = grid.fields().getFirst();
                if (!grid.relation().equals(review[0]) || !identity.name().equals(review[2]) || !identity.type().equals(review[3]) ||
                        !Integer.toString(identity.number()).equals(review[11]) ||
                        identity.name().equals(fieldName)) throw stale();
                Field field = grid.fields().stream().filter(item -> item.name().equals(fieldName)).findFirst().orElseThrow(PostgresGrid::stale);
                if (!field.type().equals(review[5]) || !Boolean.toString(field.nullable()).equals(review[6]) ||
                        !Integer.toString(field.number()).equals(review[12]) || !Integer.toString(field.typeModifier()).equals(review[13]) ||
                        (!field.nullable() && (original == null || replacement == null))) throw stale();
                String quoted = planIdentifier(fieldName), primary = planIdentifier(identity.name());
                String sql = "UPDATE ONLY " + qualified + " SET " + quoted + "=?::pg_catalog." + field.type() +
                    " WHERE " + primary + " OPERATOR(pg_catalog.=) ?::pg_catalog." + identity.type() +
                    " AND xmin::pg_catalog.text=? AND " + quoted +
                    "::pg_catalog.text COLLATE pg_catalog.\"C\" IS NOT DISTINCT FROM ?::pg_catalog.text" +
                    " RETURNING " + primary + "::pg_catalog.text, " + quoted + "::pg_catalog.text";
                try (PreparedStatement statement = connection.prepareStatement(sql)) {
                    statement.setQueryTimeout(5);
                    statement.setString(1, replacement);
                    statement.setString(2, review[4]);
                    statement.setString(3, review[1]);
                    statement.setString(4, original);
                    activate(statement);
                    try (ResultSet result = statement.executeQuery()) {
                        if (!result.next() || !review[4].equals(result.getString(1)) ||
                                !Objects.equals(replacement, result.getString(2)) || result.next()) throw stale();
                    } finally { ACTIVE.set(null); }
                }
                synchronized (ACTIVE) {
                    if (cancelled) throw new SQLException("Cancelled", "57014");
                }
                connection.commit();
                committed = true;
                emit("U", review[4], replacement);
            } finally {
                if (!committed) connection.rollback();
            }
        }

        static void run(Connection connection, DatabaseMetaData metadata, String expectedSchema, String schema, String table,
                String field, String encoded, boolean writing) throws Exception {
            if (!isPostgres(metadata) || metadata.getDatabaseMajorVersion() < 14 || !schema.equals(expectedSchema) ||
                    schema.startsWith("pg_") || schema.equals("information_schema")) throw scope();
            String qualified = planIdentifier(schema) + "." + planIdentifier(table);
            if (writing) update(connection, schema, table, qualified, field, encoded);
            else read(connection, metadata, schema, table, qualified);
        }
    }

    public static void main(String[] args) {
        var in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        try (var ignored = new PrintStream(OutputStream.nullOutputStream())) {
            System.setOut(ignored);
            System.setErr(ignored);
            if (!PROTOCOL.equals(in.readLine())) throw new Exception("Protocol mismatch");
            String sha = input(in), className = input(in), url = input(in), user = input(in), password = input(in);
            String operation = input(in), sql = input(in), catalog = input(in), schema = input(in), object = input(in);
            int maxRows = Integer.parseInt(input(in)), count = Integer.parseInt(input(in));
            if (maxRows < 1 || maxRows > 500) throw new Exception("Invalid row limit");
            if (count < 0 || count > 6) throw new Exception("Dependency count invalid");
            List<String> hashes = new ArrayList<>();
            for (int i = 0; i < count; i++) hashes.add(input(in));
            String expectedDatabase = input(in), expectedSchema = input(in);
            observeCancel(in);
            Path jar = Path.of("driver.jar").toAbsolutePath();
            verifyJar(jar, sha);
            List<Path> artifacts = new ArrayList<>();
            artifacts.add(jar);
            for (int i = 0; i < count; i++) {
                Path library = Path.of("library-" + i + ".jar").toAbsolutePath();
                verifyJar(library, hashes.get(i));
                artifacts.add(library);
            }
            try (var loader = new DriverLoader(artifacts)) {
                if (!loader.declaresDriver(className)) throw new SQLException("Driver class is not in primary JAR", "RB004");
                Thread.currentThread().setContextClassLoader(loader);
                Class<? extends Driver> type = Class.forName(className, false, loader).asSubclass(Driver.class);
                if (type.getClassLoader() != loader) throw new SQLException("Driver class ownership", "RB004");
                Driver driver = type.getConstructor().newInstance();
                var properties = new Properties();
                properties.setProperty("user", user);
                properties.setProperty("password", password);
                try (Connection connection = driver.connect(url, properties)) {
                    if (connection == null) throw new SQLException("Driver rejected this URL", "08001");
                    DatabaseMetaData metadata = connection.getMetaData();
                    if (!expectedDatabase.isEmpty() && (!isPostgres(metadata) || !expectedDatabase.equals(connection.getCatalog()) ||
                            !expectedSchema.equals(connection.getSchema()))) throw new SQLException("PostgreSQL connection scope changed", "RB005");
                    switch (operation) {
                        case "catalog" -> catalog(connection, metadata);
                        case "describe" -> describe(metadata, catalog, schema, object);
                        case "query" -> query(connection, metadata, sql, maxRows);
                        case "plan", "plan-review", "plan-measure" -> postgresPlan(connection, metadata, expectedSchema,
                            catalog, schema, object, sql, operation);
                        case "grid-read", "grid-update" -> PostgresGrid.run(connection, metadata, expectedSchema,
                            catalog, schema, object, sql, "grid-update".equals(operation));
                        default -> throw new Exception("Protocol operation invalid");
                    }
                }
            }
        } catch (SQLException error) {
            String state = error.getSQLState();
            try { emit("E", state != null && state.matches("[A-Z0-9]{5}") ? state : "JDBC0"); }
            catch (Exception ignored) { }
            System.exit(1);
        } catch (Exception | LinkageError error) {
            try { emit("E", "JDBC0"); }
            catch (Exception ignored) { }
            System.exit(1);
        }
    }
}
