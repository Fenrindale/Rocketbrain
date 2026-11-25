package rocketbrain.observer;

import java.lang.reflect.Array;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Provider adapter with no Hibernate/JPA linkage and no application query execution. */
public final class HibernateAccess {
    private static final int ENTITY_LIMIT = 500, ATTRIBUTE_LIMIT = 5000, FUNCTION_LIMIT = 512;
    private static final int SELECTION_LIMIT = 128, PARAMETER_LIMIT = 256, COLUMN_LIMIT = 64;
    private static final int PAYLOAD_LIMIT = 900_000;
    private HibernateAccess() {}

    public static Map<String, Object> snapshot(Object factory) {
        Map<String, Object> result = base(factory);
        List<Map<String, Object>> entities = new ArrayList<>(), functions = new ArrayList<>();
        List<Map<String, Object>> diagnostics = new ArrayList<>();
        result.put("entities", entities); result.put("functions", functions); result.put("diagnostics", diagnostics);
        result.put("sqlExecuted", false); result.put("queryExecuted", false);
        if (factory == null || Boolean.TRUE.equals(optional(factory, "isClosed"))) {
            result.put("state", "unknown"); diagnostics.add(diagnostic("factory.unavailable", "No open captured Hibernate factory is available.", null)); return result;
        }
        Object statistics = optional(factory, "getStatistics");
        boolean statisticsEnabled = Boolean.TRUE.equals(optional(statistics, "isStatisticsEnabled"));
        result.put("statistics", map("enabled", statisticsEnabled,
            "prepareStatementCount", statisticsEnabled ? number(optional(statistics, "getPrepareStatementCount")) : null,
            "queryExecutionCount", statisticsEnabled ? number(optional(statistics, "getQueryExecutionCount")) : null));
        boolean complete = true;
        try {
            Object metamodel = invoke(factory, "getMetamodel");
            List<Object> managed = values(invoke(metamodel, "getEntities"), ENTITY_LIMIT + 1);
            managed.sort(Comparator.comparing(value -> text(optional(value, "getName"), 256)));
            if (managed.size() > ENTITY_LIMIT) { managed.removeLast(); complete = false; }
            Object mapping = optional(factory, "getMappingMetamodel");
            if (mapping == null) mapping = optional(optional(factory, "getRuntimeMetamodels"), "getMappingMetamodel");
            int[] remaining = {ATTRIBUTE_LIMIT};
            for (Object type : managed) entities.add(entity(type, mapping, remaining));
            if (remaining[0] <= 0) complete = false;
        } catch (Throwable error) { complete = false; diagnostics.add(diagnostic("metadata.unavailable", "Provider metamodel APIs are unavailable for this factory.", error)); }
        try {
            Object registry = invoke(invoke(factory, "getQueryEngine"), "getSqmFunctionRegistry");
            List<String> names = new ArrayList<>();
            for (Object key : values(invoke(registry, "getValidFunctionKeys"), FUNCTION_LIMIT + 1)) if (key instanceof String value) names.add(value);
            names.sort(String::compareTo); if (names.size() > FUNCTION_LIMIT) { names.removeLast(); complete = false; }
            for (String name : names) functions.add(function(registry, name));
        } catch (Throwable error) { complete = false; diagnostics.add(diagnostic("functions.unavailable", "Provider function-registry APIs are unavailable.", error)); }
        while (estimatedBytes(result, 0) > PAYLOAD_LIMIT && (!entities.isEmpty() || !functions.isEmpty())) {
            complete = false; if (entities.size() > 1) entities.removeLast(); else if (!functions.isEmpty()) functions.removeLast(); else entities.removeLast();
        }
        result.put("state", complete ? "observed" : "partial"); result.put("truncated", !complete);
        result.put("scope", "Live provider metadata; no entity instances, row values, session, SQL translation or query execution requested.");
        return result;
    }

    public static Map<String, Object> analyze(Object factory, String hql) {
        Map<String, Object> result = base(factory);
        result.put("sqlExecuted", false); result.put("queryExecuted", false);
        result.put("selectionTypes", new ArrayList<>()); result.put("parameters", new ArrayList<>());
        result.put("diagnostics", new ArrayList<>());
        if (factory == null || Boolean.TRUE.equals(optional(factory, "isClosed"))) return unknown(result, "factory.unavailable", "No open captured Hibernate factory is available.", null);
        if (hql == null || hql.isBlank() || hql.length() > 32768 || hql.indexOf('\0') >= 0) return unknown(result, "query.bounds", "Provide a nonempty HQL/JPQL query within the 32768-character limit.", null);
        try {
            // Direct semantic interpretation: no Session, Query, SQL AST or binding values.
            Object sqm = translate(factory,hql);
            result.putAll(describeStatement(sqm)); result.putAll(base(factory));
            result.put("analysis", "hibernate-semantic-compile-only");
            return result;
        } catch (Throwable error) {
            Throwable cause = unwrap(error);
            result.put("state", semanticFailure(cause) ? "invalid" : "unknown");
            @SuppressWarnings("unchecked") List<Map<String, Object>> diagnostics = (List<Map<String, Object>>) result.get("diagnostics");
            diagnostics.add(diagnostic(semanticFailure(cause) ? "hibernate.semantic.invalid" : "hibernate.semantic.unavailable", semanticFailure(cause) ? "The active Hibernate provider rejected this query during semantic compilation." : "The active provider could not complete semantic compilation.", cause));
            return result;
        }
    }

    static Object translate(Object factory,String hql) throws Throwable {
        Object engine=invoke(factory,"getQueryEngine"), translator=invoke(engine,"getHqlTranslator");
        return invoke(translator,"translate",hql,null);
    }

    /** Used both by explicit probes and instrumentation of actual successful translations. */
    public static Map<String, Object> describeStatement(Object statement) {
        Map<String, Object> result = new LinkedHashMap<>();
        List<Map<String, Object>> selections = new ArrayList<>(), parameters = new ArrayList<>(), diagnostics = new ArrayList<>();
        result.put("selectionTypes", selections); result.put("parameters", parameters); result.put("diagnostics", diagnostics);
        result.put("sqlExecuted", false); result.put("queryExecuted", false); result.put("analysis", "observed-provider-SQM-metadata");
        if (statement == null) return unknown(result, "sqm.unavailable", "No successful provider semantic statement was captured.", null);
        result.put("statementClass", statement.getClass().getName());
        boolean complete = true;
        try {
            Object part = optional(statement, "getQueryPart");
            if (part == null) part = optional(statement, "getQuerySpec");
            if (part != null) {
                Object spec = optional(part, "getFirstQuerySpec"); if (spec == null) spec = part;
                Object clause = invoke(spec, "getSelectClause");
                List<Object> selected = values(invoke(clause, "getSelections"), SELECTION_LIMIT + 1);
                if (selected.size() > SELECTION_LIMIT) { selected.removeLast(); complete = false; }
                for (Object selection : selected) {
                    Object node = optional(selection, "getSelectableNode"); if (node == null) node = selection;
                    String javaType = javaType(node);
                    Map<String, Object> item = map("javaType", javaType, "state", javaType == null ? "unknown" : "observed");
                    Object alias = optional(selection, "getAlias"); if (alias instanceof String value) item.put("alias", text(value, 256));
                    if (javaType == null) complete = false;
                    selections.add(item);
                }
                result.put("statementKind", "select");
            } else {
                // DML semantic compilation is allowed; executing DML is never part of this API.
                String name = statement.getClass().getSimpleName();
                if (name.contains("Update")) result.put("statementKind", "update");
                else if (name.contains("Delete")) result.put("statementKind", "delete");
                else if (name.contains("Insert")) result.put("statementKind", "insert");
                else { result.put("statementKind", "unknown"); complete = false; }
            }
        } catch (Throwable error) { complete = false; diagnostics.add(diagnostic("sqm.selections.unknown", "Selection type metadata is unavailable through the supported public APIs.", error)); }
        try {
            List<Object> args = values(invoke(statement, "getSqmParameters"), PARAMETER_LIMIT + 1);
            if (args.size() > PARAMETER_LIMIT) { args.removeLast(); complete = false; }
            Map<String, Map<String, Object>> unique = new LinkedHashMap<>();
            for (Object parameter : args) {
                String name = string(optional(parameter, "getName")); Object position = optional(parameter, "getPosition");
                String type = javaType(parameter);
                if (type == null) type = javaType(optional(parameter, "getAnticipatedType"));
                Map<String, Object> item = map("javaType", type, "state", type == null ? "unknown" : "observed");
                if (name != null) item.put("name", text(name, 256)); if (position instanceof Number number) item.put("position", number.intValue());
                Object multi = optional(parameter, "allowMultiValuedBinding"); if (multi instanceof Boolean) item.put("multiValued", multi);
                String key = name != null ? ":" + name : "?" + position;
                Map<String, Object> previous = unique.get(key);
                if (previous == null) unique.put(key, item);
                else if (!java.util.Objects.equals(previous.get("javaType"), type)) { previous.put("javaType", null); previous.put("state", "unknown"); previous.put("reason", "Provider parameter occurrences have differing or unresolved anticipated types."); }
            }
            parameters.addAll(unique.values());
        } catch (Throwable error) { complete = false; diagnostics.add(diagnostic("sqm.parameters.unknown", "Parameter metadata is unavailable through the supported public APIs.", error)); }
        result.put("state", complete ? "known" : "unknown");
        result.put("validityScope", "Accepted provider semantic model only; SQL rendering, database execution, parameter values and application behavior are unverified.");
        return result;
    }

    private static Map<String, Object> entity(Object type, Object mapping, int[] remaining) {
        String name = text(optional(type, "getName"), 256); Object javaClass = optional(type, "getJavaType");
        String fqn = javaClass instanceof Class<?> value ? value.getName() : null;
        Map<String, Object> entity = map("name", name, "javaType", fqn);
        entity.put("abstract", javaClass instanceof Class<?> value && Modifier.isAbstract(value.getModifiers()));
        List<Map<String, Object>> attributes = new ArrayList<>(), physical = new ArrayList<>();
        entity.put("attributes", attributes); entity.put("physicalMappings", physical);
        List<Object> attrs = values(optional(type, "getAttributes"), Math.min(remaining[0], ATTRIBUTE_LIMIT) + 1);
        attrs.sort(Comparator.comparing(a -> text(optional(a, "getName"), 256)));
        Object persister = optional(mapping, "findEntityDescriptor", fqn != null ? fqn : name);
        if (persister == null && javaClass instanceof Class<?>) persister = optional(mapping, "findEntityDescriptor", javaClass);
        if (persister != null) {
            entity.put("table", string(optional(persister, "getTableName")));
            List<String> tableNames = stringValues(optional(persister, "getTableNames"), 128);
            entity.put("tables", tableNames);
            entity.put("identifierColumns", stringValues(optional(persister, "getIdentifierColumnNames"), COLUMN_LIMIT));
            List<Map<String, Object>> keys = new ArrayList<>();
            for (int i = 0; i < tableNames.size(); i++) keys.add(map("table", tableNames.get(i), "columns", stringValues(optional(persister, "getKeyColumns", i), COLUMN_LIMIT)));
            entity.put("tableKeys", keys);
            entity.put("inheritance", hierarchyContains(persister, "org.hibernate.persister.entity.UnionSubclassEntityPersister") ? "TABLE_PER_CLASS" : hierarchyContains(persister, "org.hibernate.persister.entity.JoinedSubclassEntityPersister") ? "JOINED" : hierarchyContains(persister, "org.hibernate.persister.entity.SingleTableEntityPersister") ? "SINGLE_TABLE" : "unknown");
        }
        for (Object attribute : attrs) {
            if (remaining[0]-- <= 0) break;
            String property = text(optional(attribute, "getName"), 256); Object attrType = optional(attribute, "getJavaType");
            Map<String, Object> item = map("name", property, "javaType", attrType instanceof Class<?> c ? c.getName() : null);
            Object kind = optional(attribute, "getPersistentAttributeType"); item.put("kind", kind instanceof Enum<?> e ? e.name() : "unknown");
            item.put("association", Boolean.TRUE.equals(optional(attribute, "isAssociation"))); item.put("collection", Boolean.TRUE.equals(optional(attribute, "isCollection")));
            attributes.add(item);
            Object attributeMapping = optional(persister, "findAttributeMapping", property);
            if (attributeMapping == null) attributeMapping = optional(persister, "findSubPart", property);
            if (attributeMapping != null) physical(attributeMapping, property, physical, 0, new IdentityHashMap<>());
        }
        // TABLE_PER_CLASS may reuse an inherited AttributeMapping whose declaring
        // table is abstract. The concrete persister exposes the actual owning
        // table through a public API; do not infer it from annotation names.
        if (hierarchyContains(persister, "org.hibernate.persister.entity.UnionSubclassEntityPersister") && !Boolean.TRUE.equals(entity.get("abstract"))) {
            for (Map<String, Object> item : physical) {
                @SuppressWarnings("unchecked") List<Map<String, Object>> columns = (List<Map<String, Object>>) item.get("columns");
                for (Map<String, Object> column : columns) {
                    if (Boolean.TRUE.equals(column.get("formula")) || !(column.get("column") instanceof String columnName)) continue;
                    String table = string(optional(persister, "getTableNameForColumn", columnName));
                    if (table != null) { column.put("declaringTable", column.get("table")); column.put("table", table); column.put("tableSource", "concrete-entity-persister"); }
                    else column.put("table", null);
                }
            }
        }
        entity.put("mappingState", persister == null ? "unknown" : "observed");
        return entity;
    }

    private static void physical(Object mapping, String path, List<Map<String, Object>> output, int depth, IdentityHashMap<Object, Boolean> seen) {
        if (mapping == null || depth > 8 || output.size() >= 512 || seen.put(mapping, Boolean.TRUE) != null) return;
        Object embedded = optional(mapping, "getEmbeddableTypeDescriptor");
        Object count = optional(embedded, "getNumberOfAttributeMappings");
        if (count instanceof Number size && size.intValue() > 0 && size.intValue() <= 128) {
            for (int i = 0; i < size.intValue(); i++) { Object child = optional(embedded, "getAttributeMapping", i); String name = string(optional(child, "getAttributeName")); if (name != null) physical(child, path + "." + name, output, depth + 1, seen); }
            return;
        }
        List<Map<String, Object>> columns = selectables(mapping);
        Map<String, Object> item = map("property", text(path, 512), "columns", columns, "state", columns.isEmpty() ? "unknown" : "observed");
        Object collection = optional(mapping, "getCollectionDescriptor");
        if (collection != null) {
            item.put("collectionTable", string(optional(collection, "getTableName")));
            item.put("ownerColumns", stringValues(optional(collection, "getKeyColumnNames"), COLUMN_LIMIT));
            item.put("elementColumns", stringValues(optional(collection, "getElementColumnNames"), COLUMN_LIMIT));
            item.put("state", "observed");
        }
        output.add(item);
    }

    private static List<Map<String, Object>> selectables(Object mapping) {
        List<Map<String, Object>> columns = new ArrayList<>();
        if (optional(mapping, "getSelectionExpression") instanceof String) { columns.add(selectable(mapping)); return columns; }
        try {
            Method method = null;
            for (Method candidate : mapping.getClass().getMethods()) if (candidate.getName().equals("forEachSelectable") && candidate.getParameterCount() == 1 && candidate.getParameterTypes()[0].isInterface()) { method = accessible(mapping.getClass(), candidate); break; }
            if (method == null) return columns;
            Class<?> consumer = method.getParameterTypes()[0];
            Object callback = Proxy.newProxyInstance(consumer.getClassLoader(), new Class<?>[]{consumer}, (proxy, called, args) -> {
                if (called.getName().equals("accept") && args != null && args.length == 2 && columns.size() < COLUMN_LIMIT) columns.add(selectable(args[1]));
                if (called.getName().equals("hashCode")) return System.identityHashCode(proxy);
                if (called.getName().equals("equals")) return proxy == (args == null ? null : args[0]);
                if (called.getName().equals("toString")) return "RocketbrainSelectableMetadataConsumer";
                return null;
            });
            if (method != null) method.invoke(mapping, callback);
        } catch (Throwable ignored) { /* Missing public mapping APIs remain unknown. */ }
        return columns;
    }

    private static Map<String, Object> selectable(Object column) {
        boolean formula = Boolean.TRUE.equals(optional(column, "isFormula"));
        Map<String, Object> result = map("table", string(optional(column, "getContainingTableExpression")), "column", formula ? null : string(optional(column, "getSelectionExpression")), "formula", formula);
        Object jdbc = optional(column, "getJdbcMapping"), jdbcType = optional(jdbc, "getJdbcType");
        Object code = optional(jdbcType, "getJdbcTypeCode"); if (code instanceof Number) result.put("jdbcTypeCode", code);
        String javaType = javaType(optional(jdbc, "getJdbcJavaType")); if (javaType != null) result.put("jdbcJavaType", javaType);
        return result;
    }

    private static Map<String, Object> function(Object registry, String name) {
        Map<String, Object> result = map("name", text(name, 256), "state", "observed");
        Object descriptor = optional(registry, "findFunctionDescriptor", name);
        if (descriptor == null) { descriptor = optional(registry, "findSetReturningFunctionDescriptor", name); result.put("setReturning", true); }
        if (descriptor == null) { result.put("state", "unknown"); return result; }
        result.put("descriptorClass", descriptor.getClass().getName());
        Object kind = optional(descriptor, "getFunctionKind"); if (kind instanceof Enum<?> e) result.put("kind", e.name());
        result.put("signature", string(optional(descriptor, "getSignature", name)));
        Object validator = optional(descriptor, "getArgumentsValidator");
        String signature = string(optional(validator, "getSignature")); result.put("argumentSignature", signature);
        String returns = string(optional(descriptor, "getReturnSignature"));
        if (returns == null) returns = string(optional(optional(descriptor, "getReturnTypeResolver"), "getReturnType"));
        result.put("returnSignature", returns);
        result.put("returns", map("state", "unknown", "reason", "Display signatures do not establish a context-independent Java return type. Use a concrete semantic probe for query-specific types."));
        List<Map<String, Object>> args = new ArrayList<>(); result.put("arguments", args);
        // Parse only a finite signature emitted by Hibernate's exact public validator.
        if (signature != null && validator != null && validator.getClass().getName().equals("org.hibernate.query.sqm.produce.function.ArgumentTypesValidator") && signature.matches("\\((?:[A-Z_]+ arg[0-9]*(?:, [A-Z_]+ arg[0-9]*)*)?\\)")) {
            Matcher matcher = Pattern.compile("([A-Z_]+) arg[0-9]*").matcher(signature);
            while (matcher.find() && args.size() < 64) args.add(map("category", matcher.group(1), "state", "observed"));
            result.put("minArgs", args.size()); result.put("maxArgs", args.size());
        } else result.put("argumentTypesState", "unknown");
        return result;
    }

    static String javaType(Object node) {
        if (node == null) return null; if (node instanceof Class<?> c) return c.getName();
        for (String name : new String[]{"getJavaTypeClass", "getJavaType", "getBindableJavaType", "getParameterType"}) { Object value = optional(node, name); if (value instanceof Class<?> c) return c.getName(); }
        for (String name : new String[]{"getNodeJavaType", "getExpressibleJavaType", "getJavaTypeDescriptor"}) { Object descriptor = optional(node, name); if (descriptor != null && descriptor != node) { Object value = optional(descriptor, "getJavaTypeClass"); if (value instanceof Class<?> c) return c.getName(); } }
        Object type = optional(node, "getNodeType"); if (type != null && type != node) { Object descriptor = optional(type, "getExpressibleJavaType"); Object value = optional(descriptor, "getJavaTypeClass"); if (value instanceof Class<?> c) return c.getName(); }
        return null;
    }

    private static Map<String, Object> base(Object factory) {
        String version = null;
        if (factory != null) {
            try { Class<?> type = Class.forName("org.hibernate.Version", false, factory.getClass().getClassLoader()); Object value = type.getMethod("getVersionString").invoke(null); if (value instanceof String s) version = text(s, 128); } catch (Throwable ignored) {}
            if (version == null) version = factory.getClass().getPackage().getImplementationVersion();
        }
        return map("provider", "hibernate", "version", version);
    }
    private static Map<String, Object> unknown(Map<String, Object> result, String code, String message, Throwable error) {
        result.put("state", "unknown");
        @SuppressWarnings("unchecked") List<Map<String, Object>> diagnostics = (List<Map<String, Object>>) result.computeIfAbsent("diagnostics", ignored -> new ArrayList<>());
        diagnostics.add(diagnostic(code, message, error)); return result;
    }
    private static Map<String, Object> diagnostic(String code, String message, Throwable error) {
        Map<String, Object> value = map("code", code, "message", message);
        if (error != null) value.put("exceptionType", unwrap(error).getClass().getName());
        // Provider messages may echo query literals. Never return/log the raw message.
        return value;
    }
    private static boolean semanticFailure(Throwable error) {
        int depth = 0;
        for (Throwable cause = error; cause != null && depth++ < 16; cause = cause.getCause()) {
            String name = cause.getClass().getName();
            if (name.startsWith("org.hibernate.query.") && (name.endsWith("Exception") || name.endsWith("Error"))) return true;
            if (name.equals("org.hibernate.QueryException") || name.startsWith("org.hibernate.grammars.hql.")) return true;
        }
        return false;
    }
    private static Throwable unwrap(Throwable value) { int depth = 0; while (value instanceof InvocationTargetException e && e.getCause() != null && depth++ < 16) value = e.getCause(); return value; }
    static Object optional(Object receiver, String name, Object... args) { try { return receiver == null ? null : invoke(receiver, name, args); } catch (Throwable ignored) { return null; } }
    static Object invoke(Object receiver, String name, Object... args) throws Throwable {
        if (receiver == null) throw new NoSuchMethodException(name);
        Method chosen = null;
        for (Method method : receiver.getClass().getMethods()) {
            if (!method.getName().equals(name) || method.getParameterCount() != args.length || Modifier.isStatic(method.getModifiers())) continue;
            boolean match = true; Class<?>[] types = method.getParameterTypes();
            for (int i = 0; i < args.length; i++) if (args[i] == null ? types[i].isPrimitive() : !boxed(types[i]).isInstance(args[i])) { match = false; break; }
            if (match) { chosen = accessible(receiver.getClass(), method); if (chosen != null) break; }
        }
        if (chosen == null) throw new NoSuchMethodException(receiver.getClass().getName() + "." + name);
        try { return chosen.invoke(receiver, args); } catch (InvocationTargetException error) { throw unwrap(error); }
    }
    private static Method accessible(Class<?> receiver, Method method) {
        if (Modifier.isPublic(method.getDeclaringClass().getModifiers())) return method;
        return declaration(receiver, method.getName(), method.getParameterTypes(), new java.util.HashSet<>());
    }
    private static Method declaration(Class<?> type, String name, Class<?>[] parameters, Set<Class<?>> seen) {
        if (type == null || !seen.add(type)) return null;
        if (Modifier.isPublic(type.getModifiers())) { try { Method method = type.getMethod(name, parameters); if (Modifier.isPublic(method.getDeclaringClass().getModifiers())) return method; } catch (NoSuchMethodException ignored) {} }
        for (Class<?> contract : type.getInterfaces()) { Method method = declaration(contract, name, parameters, seen); if (method != null) return method; }
        return declaration(type.getSuperclass(), name, parameters, seen);
    }
    private static Class<?> boxed(Class<?> type) { if (!type.isPrimitive()) return type; return switch (type.getName()) { case "int" -> Integer.class; case "boolean" -> Boolean.class; case "long" -> Long.class; case "double" -> Double.class; case "float" -> Float.class; case "short" -> Short.class; case "byte" -> Byte.class; case "char" -> Character.class; default -> Void.class; }; }
    private static List<Object> values(Object value, int limit) {
        List<Object> result = new ArrayList<>(); if (limit <= 0 || value == null) return result;
        if (value instanceof Iterable<?> iterable) { for (Object item : iterable) { if (result.size() >= limit) break; result.add(item); } }
        else if (value.getClass().isArray()) { for (int i = 0; i < Math.min(Array.getLength(value), limit); i++) result.add(Array.get(value, i)); }
        return result;
    }
    private static List<String> stringValues(Object value, int limit) { List<String> result = new ArrayList<>(); for (Object item : values(value, limit)) if (item instanceof String s) result.add(text(s, 512)); return result; }
    private static String string(Object value) { return value instanceof String s ? text(s, 512) : null; }
    private static Number number(Object value) { return value instanceof Number n ? n : null; }
    private static boolean hierarchyContains(Object value, String className) { if (value == null) return false; for (Class<?> type = value.getClass(); type != null; type = type.getSuperclass()) if (type.getName().equals(className)) return true; return false; }
    private static String text(Object value, int limit) { if (!(value instanceof String s)) return ""; return s.substring(0, Math.min(s.length(), limit)).replaceAll("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]", ""); }
    private static Map<String, Object> map(Object... pairs) { Map<String, Object> value = new LinkedHashMap<>(); for (int i = 0; i < pairs.length; i += 2) value.put((String) pairs[i], pairs[i + 1]); return value; }
    private static long estimatedBytes(Object value, int depth) {
        if (depth > 32) return PAYLOAD_LIMIT;
        if (value == null) return 4; if (value instanceof String s) return 2L + s.getBytes(StandardCharsets.UTF_8).length * 6L;
        if (value instanceof Number || value instanceof Boolean) return 32;
        long count = 2;
        if (value instanceof Map<?, ?> map) for (Map.Entry<?, ?> entry : map.entrySet()) count += estimatedBytes(entry.getKey(), depth + 1) + estimatedBytes(entry.getValue(), depth + 1) + 2;
        else if (value instanceof Collection<?> list) for (Object item : list) count += estimatedBytes(item, depth + 1) + 1;
        return count;
    }
}
