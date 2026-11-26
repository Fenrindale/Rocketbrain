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

    private static void estimatedPlan(Connection connection, DatabaseMetaData metadata, String expectedSchema,
            String schema, String table, String project, String predicate) throws Exception {
        if (!isPostgres(metadata) || metadata.getDatabaseMajorVersion() < 14 || !schema.equals(expectedSchema) ||
                schema.startsWith("pg_") || schema.equals("information_schema")) throw planScope();
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
            String relation = planRelation(connection, schema, table);
            setup.execute("LOCK TABLE ONLY " + qualified + " IN ACCESS SHARE MODE NOWAIT");
            if (!relation.equals(planRelation(connection, schema, table))) throw planScope();
            final var columns = planColumns(connection, relation);
            if (all ? columns.isEmpty() || columns.containsValue(null) : names.stream().anyMatch(name -> columns.get(name) == null)) {
                throw planScope();
            }
            String type = filter.length == 2 ? columns.get(filter[0]) : "";
            if (filter.length == 2 && (type == null || !List.of("int2", "int4", "int8").contains(type))) throw planScope();
            String sql = "EXPLAIN (ANALYZE FALSE, VERBOSE TRUE, COSTS TRUE, FORMAT JSON) SELECT " +
                (all ? "*" : String.join(", ", projections)) + " FROM ONLY " + qualified +
                (filter.length == 2 ? " WHERE " + filterName + " OPERATOR(pg_catalog.=) ?::pg_catalog." + type : "");
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
            emit("P", metadata.getDatabaseProductVersion(), relation, document);
        } finally { connection.rollback(); }
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
                        case "plan" -> estimatedPlan(connection, metadata, expectedSchema, catalog, schema, object, sql);
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
