package rocketbrain.observer;

import static rocketbrain.observer.HibernateAccess.invoke;

import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/** Provides scalar rows for one entity alias without hydrating provider objects. */
final class ConsoleEntityProjection {
    private static final String SELECT = "org.hibernate.query.sqm.tree.select.";
    private static final String DOMAIN = "org.hibernate.query.sqm.tree.domain.";
    private static final String ROOT = "org.hibernate.query.sqm.tree.from.SqmRoot";
    private static final String MAPPING = "unsupported_entity_projection_mapping";
    private static final String SHAPE = "unsupported_entity_projection_shape";
    private static final Pattern PROJECTION = Pattern.compile(
        "(?is)^\\s*select\\s+(?:distinct\\s+)?([A-Za-z_][A-Za-z0-9_]{0,127})\\s+(?=from\\b)");
    private static final Set<String> TO_ONE = Set.of("ONE_TO_ONE", "MANY_TO_ONE");
    private static final Set<String> ID_TYPES = Set.of(
        "java.lang.String", "java.lang.Long", "java.lang.Integer", "java.lang.Short", "java.lang.Byte", "java.util.UUID");
    private static final Set<String> BASIC_TYPES = Set.of(
        "org.hibernate.type.internal.BasicTypeImpl", "org.hibernate.type.internal.NamedBasicTypeImpl",
        "org.hibernate.type.internal.ImmutableNamedBasicTypeImpl", "org.hibernate.type.internal.PrimitiveBasicTypeImpl");
    private static final Map<String, String> BOXED = Map.of("long", "java.lang.Long", "int", "java.lang.Integer",
        "short", "java.lang.Short", "byte", "java.lang.Byte", "boolean", "java.lang.Boolean",
        "double", "java.lang.Double", "float", "java.lang.Float");

    private ConsoleEntityProjection() { }

    record Field(String name, String type, boolean id, String table, String column) {}
    record Alias(Object node, boolean nullable) {}
    record Plan(String query, String javaType, String alias, boolean nullable, List<Field> fields,
                List<String> scalarAliases, String review) {
        Map<String, Object> description() {
            return Map.of("javaType", javaType, "alias", alias, "id", fields.getFirst().name(),
                "nullable", nullable, "review", review, "scalarFieldsOnly", true);
        }

        List<Map<String, Object>> reviewedColumns(List<Map<String, Object>> columns) {
            if (columns.size() != fields.size()) throw new ConsoleQuery.Refusal(MAPPING);
            for (int index = 0; index < fields.size(); index++) {
                var column = columns.get(index);
                var field = fields.get(index);
                if (!scalarAliases.get(index).equals(column.get("alias")) || !field.type().equals(column.get("javaType"))) {
                    throw new ConsoleQuery.Refusal(MAPPING);
                }
            }
            return fields.stream().map(field -> Map.<String, Object>of("alias", field.name(), "javaType", field.type())).toList();
        }
    }

    static Plan plan(Object factory, Object statement, String hql, boolean advanced) throws Throwable {
        var initial = PROJECTION.matcher(hql);
        if (!initial.find()) return null;
        if (advanced || statement == null || !statement.getClass().getName().equals(SELECT + "SqmSelectStatement")) {
            throw new ConsoleQuery.Refusal(SHAPE);
        }
        String alias = initial.group(1);
        Object spec = invoke(statement, "getQueryPart");
        if (!spec.getClass().getName().equals(SELECT + "SqmQuerySpec") ||
                !items(invoke(statement, "getCteStatements"), 0, SHAPE).isEmpty() ||
                !items(invoke(spec, "getGroupByClauseExpressions"), 0, SHAPE).isEmpty() ||
                invoke(spec, "getHavingClausePredicate") != null) throw new ConsoleQuery.Refusal(SHAPE);
        Object root = only(invoke(invoke(spec, "getFromClause"), "getRoots"));
        Object selection = invoke(only(invoke(invoke(spec, "getSelectClause"), "getSelections")), "getSelectableNode");
        if (!root.getClass().getName().equals(ROOT) || !alias.equals(invoke(selection, "getExplicitAlias"))) {
            throw new ConsoleQuery.Refusal(SHAPE);
        }
        var aliases = new ArrayList<Alias>();
        inspectAliases(root, false, aliases);
        var selected = aliases.stream().filter(value -> value.node() == selection).findFirst()
            .orElseThrow(() -> new ConsoleQuery.Refusal(SHAPE));
        assertProvider(factory);
        if (!(invoke(invoke(selection, "getModel"), "getJavaType") instanceof Class<?> type) ||
                type.isInterface() || Modifier.isAbstract(type.getModifiers())) throw new ConsoleQuery.Refusal(MAPPING);
        List<Field> fields = fields(factory, type);
        var used = Pattern.compile("[A-Za-z_][A-Za-z_0-9]*").matcher(hql.toLowerCase(Locale.ROOT)).results()
            .map(java.util.regex.MatchResult::group).collect(Collectors.toSet());
        var scalarAliases = new ArrayList<String>();
        for (int suffix = 1; scalarAliases.size() < fields.size(); suffix++) {
            String label = "rbEntityField" + suffix;
            if (used.add(label.toLowerCase(Locale.ROOT))) scalarAliases.add(label);
        }
        var selections = new ArrayList<String>();
        for (int index = 0; index < fields.size(); index++) {
            selections.add(alias + "." + fields.get(index).name() + " as " + scalarAliases.get(index));
        }
        String scalar = String.join(", ", selections);
        String rewritten = hql.substring(0, initial.start(1)) + scalar + hql.substring(initial.end(1));
        if (!(invoke(factory, "getUuid") instanceof String identity) || identity.isBlank() || identity.length() > 128) {
            throw new ConsoleQuery.Refusal(MAPPING);
        }
        String review = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Json.encode(
            List.of("RocketbrainEntityProjection-v1", identity, hql, rewritten, type.getName(), selected.nullable(),
                fields.stream().map(field -> List.of(field.name(), field.type(), field.id(), field.table(), field.column())).toList())
        ).getBytes(StandardCharsets.UTF_8)));
        return new Plan(rewritten, type.getName(), alias, selected.nullable(), fields, List.copyOf(scalarAliases), review);
    }

    private static void assertProvider(Object factory) throws Throwable {
        Class<?> version = Class.forName("org.hibernate.Version", false, factory.getClass().getClassLoader());
        if (!(version.getMethod("getVersionString").invoke(null) instanceof String release) || !release.startsWith("7.4.")) {
            throw new ConsoleQuery.Refusal("unsupported_entity_projection_provider");
        }
    }

    private static void inspectAliases(Object from, boolean nullable, List<Alias> aliases) throws Throwable {
        if (aliases.size() >= 5 || !items(invoke(from, "getSqmTreats"), 0, SHAPE).isEmpty()) throw new ConsoleQuery.Refusal(SHAPE);
        aliases.add(new Alias(from, nullable));
        for (Object join : items(invoke(from, "getSqmJoins"), 4, SHAPE)) {
            if (!join.getClass().getName().equals(DOMAIN + "SqmSingularJoin") ||
                    !Boolean.FALSE.equals(invoke(join, "isFetched"))) throw new ConsoleQuery.Refusal(SHAPE);
            Object kind = invoke(join, "getSqmJoinType");
            if (!(kind instanceof Enum<?> direction) || !Set.of("LEFT", "INNER").contains(direction.name())) {
                throw new ConsoleQuery.Refusal(SHAPE);
            }
            var attribute = invoke(join, "getAttribute");
            if (!(invoke(attribute, "getPersistentAttributeType") instanceof Enum<?> relationship) ||
                    !TO_ONE.contains(relationship.name()) || !Boolean.TRUE.equals(invoke(attribute, "isAssociation")) ||
                    !Boolean.FALSE.equals(invoke(attribute, "isCollection"))) {
                throw new ConsoleQuery.Refusal(SHAPE);
            }
            inspectAliases(join, nullable || direction.name().equals("LEFT"), aliases);
        }
    }

    private static List<Field> fields(Object factory, Class<?> type) throws Throwable {
        Object entity = invoke(invoke(factory, "getMetamodel"), "entity", type);
        Object persister = invoke(invoke(factory, "getMappingMetamodel"), "getEntityDescriptor", type);
        if (!persister.getClass().getName().equals("org.hibernate.persister.entity.SingleTableEntityPersister") ||
                !Boolean.FALSE.equals(invoke(persister, "hasSubclasses")) || !Integer.valueOf(1).equals(invoke(persister, "getTableSpan")) ||
                !invoke(persister, "getEntityName").equals(invoke(persister, "getRootEntityName"))) {
            throw new ConsoleQuery.Refusal(MAPPING);
        }
        var result = new ArrayList<Field>();
        var names = new HashSet<String>();
        for (Object attribute : items(invoke(entity, "getAttributes"), 64, MAPPING)) {
            Object classification = invoke(attribute, "getPersistentAttributeType");
            if (!(classification instanceof Enum<?> kind)) throw new ConsoleQuery.Refusal(MAPPING);
            if (!kind.name().equals("BASIC")) continue;
            if (!(invoke(attribute, "getName") instanceof String name) || !name.matches("[A-Za-z_][A-Za-z0-9_]{0,127}") ||
                    !names.add(name.toLowerCase(Locale.ROOT)) || result.size() >= ConsoleQuery.MAX_COLUMNS ||
                    !(invoke(attribute, "getJavaType") instanceof Class<?> javaType)) throw new ConsoleQuery.Refusal(MAPPING);
            String scalar = BOXED.getOrDefault(javaType.getName(), javaType.getName());
            boolean id = Boolean.TRUE.equals(invoke(attribute, "isId"));
            if (!ConsoleQuery.safeType(scalar) || id && !ID_TYPES.contains(scalar)) throw new ConsoleQuery.Refusal(MAPPING);
            Object part = id ? invoke(persister, "getIdentifierMapping") : invoke(persister, "findAttributeMapping", name);
            Object jdbc = invoke(part, "getJdbcMapping");
            Object jdbcType = invoke(jdbc, "getJdbcType");
            Object read = invoke(part, "getCustomReadExpression");
            if (!BASIC_TYPES.contains(jdbc.getClass().getName()) || invoke(jdbc, "getValueConverter") != null ||
                    !invoke(jdbc, "getJdbcJavaType").getClass().getName().startsWith("org.hibernate.type.descriptor.java.") ||
                    !jdbcType.getClass().getName().startsWith("org.hibernate.type.descriptor.jdbc.") ||
                    !Boolean.FALSE.equals(invoke(jdbcType, "isLobOrLong")) || !Boolean.FALSE.equals(invoke(part, "isFormula")) ||
                    !(invoke(part, "getContainingTableExpression") instanceof String table) || !physicalName(table) ||
                    !(invoke(part, "getSelectionExpression") instanceof String column) || !physicalName(column) ||
                    // Hibernate 7.4 represents its default qualified read with the table alias placeholder.
                    read != null && !read.equals("{@}." + column)) {
                throw new ConsoleQuery.Refusal(MAPPING);
            }
            result.add(new Field(name, scalar, id, table, column));
        }
        if (result.stream().filter(Field::id).count() != 1) throw new ConsoleQuery.Refusal(MAPPING);
        result.sort(Comparator.comparing(Field::id).reversed().thenComparing(Field::name));
        return List.copyOf(result);
    }

    private static boolean physicalName(String name) {
        return name.matches("[A-Za-z_0-9.$`\"]{1,256}");
    }

    private static Collection<?> items(Object value, int maximum, String refusal) {
        if (!(value instanceof Collection<?> values) || values.size() > maximum) throw new ConsoleQuery.Refusal(refusal);
        return values;
    }

    private static Object only(Object value) {
        var items = items(value, 1, SHAPE);
        if (items.isEmpty()) throw new ConsoleQuery.Refusal(SHAPE);
        return items.iterator().next();
    }
}
