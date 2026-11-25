package rocketbrain.observer;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Bounded, provider-typed scalar selection shared by the describe and execute routes. */
final class ConsoleQuery {
    static final int MAX_PARAMETERS = 16, MAX_COLUMNS = 16, MAX_ROWS = 100, MAX_QUERY = 4096;
    private static final Set<String> FUNCTIONS = Set.of("count","sum","avg","min","max","lower","upper","length","character_length",
        "char_length","abs","coalesce","nullif","concat","substring","round","floor","ceil","ceiling","mod");
    private static final Set<String> GROUPS = Set.of("in","exists","select","where","on","and","or","not","having","from","over");
    private static final Set<String> BLOCKED = Set.of("insert","update","delete","merge","truncate","drop","alter","create","set","replace",
        "call","execute","grant","revoke","handler","lock","unlock","share","into","outfile","dumpfile","procedure","do","function","sql",
        "fetch","new","with","recursive","union","except","intersect","lateral","window","returning","limit","offset","over");
    private static final Pattern TOKEN = Pattern.compile(
        "[ \\t\\r\\n]+|[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\\.[0-9]+)?|[(),.?>:=<!+*/%-]|`[A-Za-z_][A-Za-z0-9_]*`");
    private static final Set<String> SAFE_TYPES = Set.of(
        "java.lang.String","java.lang.Long","java.lang.Integer","java.lang.Short","java.lang.Byte","java.lang.Boolean",
        "java.lang.Double","java.lang.Float","java.math.BigDecimal","java.math.BigInteger",
        "java.time.LocalDate","java.time.LocalTime","java.time.LocalDateTime","java.time.Instant","java.util.UUID");
    private static final long MAX_RESULT_BYTES = 384 * 1024;
    private ConsoleQuery() {}

    record Parameter(String name, Integer position, String javaType) {
        String key() { return name != null ? ":" + name : "?" + position; }
        Object selector() { return name != null ? name : position; }
    }
    record Prepared(String query,List<Map<String,Object>> columns,List<Parameter> parameters,Map<String,Object> description) {}
    record Bound(Parameter parameter,Object value,Class<?> javaType) {}
    static final class Refusal extends IllegalArgumentException {
        final String code;
        Refusal(String code) { super(code); this.code = code; }
    }

    static Prepared describe(Object factory,String text) {
        inspect(text,false);
        Map<String,Object> semantic = HibernateAccess.analyze(factory,text);
        if (!"known".equals(semantic.get("state"))) throw new Refusal("provider_validation_failed");
        if (!"select".equals(semantic.get("statementKind"))) throw new Refusal("select_required");
        List<Map<String,Object>> columns = descriptors(semantic.get("selectionTypes"),MAX_COLUMNS);
        if (columns.isEmpty()) throw new Refusal("scalar_projection_required");
        for (Map<String,Object> column : columns) {
            if (!(column.get("javaType") instanceof String type) || !SAFE_TYPES.contains(type)) throw new Refusal("scalar_projection_required");
        }
        List<Parameter> parameters = new ArrayList<>();
        for (Map<String,Object> item : descriptors(semantic.get("parameters"),MAX_PARAMETERS)) {
            Object type = item.get("javaType"), name = item.get("name"), ordinal = item.get("position");
            if (!(type instanceof String javaType) || !SAFE_TYPES.contains(javaType) || Boolean.TRUE.equals(item.get("multiValued")))
                throw new Refusal("unsupported_parameter_type");
            if (name instanceof String key && key.matches("[A-Za-z_][A-Za-z0-9_]{0,63}") && ordinal == null) {
                parameters.add(new Parameter(key,null,javaType));
            } else if (ordinal instanceof Integer number && number>=1 && number<=256 && name==null) {
                parameters.add(new Parameter(null,number,javaType));
            } else throw new Refusal("unsupported_parameter_key");
        }
        parameters.sort(java.util.Comparator.comparing(Parameter::key));
        Map<String,Object> description = new LinkedHashMap<>();
        description.put("state","described");
        description.put("columns",columns);
        description.put("parameters",parameters.stream().map(parameter->Map.of("key",parameter.key(),"javaType",parameter.javaType())).toList());
        description.put("sqlExecuted",false);
        return new Prepared(text,List.copyOf(columns),List.copyOf(parameters),description);
    }

    static List<Bound> bind(Prepared prepared,Object input) {
        if (!(input instanceof Map<?,?> values) || !values.keySet().equals(
                new java.util.HashSet<>(prepared.parameters().stream().map(Parameter::key).toList()))) {
            throw new Refusal("parameter_keys_mismatch");
        }
        List<Bound> result = new ArrayList<>();
        for (Parameter parameter : prepared.parameters()) {
            Object value = values.get(parameter.key());
            if (value != null && (!(value instanceof String text) || text.length()>1024 || text.indexOf('\0')>=0))
                throw new Refusal("invalid_parameter_value");
            try {
                Class<?> type = Class.forName(parameter.javaType(),false,null);
                result.add(new Bound(parameter,decode(parameter.javaType(),(String)value),type));
            } catch (ClassNotFoundException | RuntimeException error) { throw new Refusal("invalid_parameter_value"); }
        }
        return result;
    }

    private static Object decode(String type,String value) {
        if (value == null) return null;
        if (type.equals("java.lang.String")) return value;
        if (value.length()>128 || !value.equals(value.trim())) throw new Refusal("invalid_parameter_value");
        return switch(type) {
            case "java.lang.Long" -> Long.valueOf(value);
            case "java.lang.Integer" -> Integer.valueOf(value);
            case "java.lang.Short" -> Short.valueOf(value);
            case "java.lang.Byte" -> Byte.valueOf(value);
            case "java.lang.Boolean" -> {
                if (!value.equals("true") && !value.equals("false")) throw new Refusal("invalid_parameter_value");
                yield Boolean.valueOf(value);
            }
            case "java.lang.Double" -> {
                double number = Double.parseDouble(value);
                if (!Double.isFinite(number)) throw new Refusal("invalid_parameter_value");
                yield number;
            }
            case "java.lang.Float" -> {
                float number = Float.parseFloat(value);
                if (!Float.isFinite(number)) throw new Refusal("invalid_parameter_value");
                yield number;
            }
            case "java.math.BigDecimal" -> {
                BigDecimal number = new BigDecimal(value);
                if (Math.abs((long)number.scale())>128) throw new Refusal("invalid_parameter_value");
                yield number;
            }
            case "java.math.BigInteger" -> new BigInteger(value);
            case "java.time.LocalDate" -> LocalDate.parse(value);
            case "java.time.LocalTime" -> LocalTime.parse(value);
            case "java.time.LocalDateTime" -> LocalDateTime.parse(value);
            case "java.time.Instant" -> Instant.parse(value);
            case "java.util.UUID" -> {
                UUID uuid = UUID.fromString(value);
                if (!uuid.toString().equalsIgnoreCase(value)) throw new Refusal("invalid_parameter_value");
                yield uuid;
            }
            default -> throw new Refusal("unsupported_parameter_type");
        };
    }

    static void inspect(String text,boolean sql) {
        int limit = sql ? 16384 : MAX_QUERY;
        String refusal = sql ? "rendered_sql_not_allowed" : "unsupported_select_shape";
        if (text==null || text.length()>limit || text.contains("--") || text.contains("/*") || text.contains("*/"))
            throw new Refusal(refusal);
        List<String> tokens = new ArrayList<>();
        Matcher matcher = TOKEN.matcher(text);
        int end = 0;
        while (matcher.find()) {
            if (matcher.start()!=end) throw new Refusal(refusal);
            end = matcher.end();
            String token = matcher.group();
            if (!token.isBlank()) tokens.add(token.toLowerCase(Locale.ROOT));
            if (tokens.size()>1024) throw new Refusal(refusal);
        }
        if (end!=text.length() || tokens.size()<4 || !tokens.getFirst().equals("select") || !tokens.contains("from"))
            throw new Refusal(refusal);
        int depth = 0;
        for(int i=0;i<tokens.size();i++) {
            String token=tokens.get(i);
            boolean named = i>0 && tokens.get(i-1).equals(":");
            if (token.startsWith("`") && !sql || token.equals(":") && sql ||
                !named && BLOCKED.contains(token) && !(sql && token.equals("limit"))) throw new Refusal(refusal);
            if (token.equals("(") && ++depth>12 || token.equals(")") && --depth<0) throw new Refusal(refusal);
            if (i+1<tokens.size() && tokens.get(i+1).equals("(") &&
                (Character.isLetter(token.charAt(0)) || token.startsWith("_") || token.startsWith("`"))) {
                if (!GROUPS.contains(token) && !FUNCTIONS.contains(token) || i>0 && tokens.get(i-1).equals("."))
                    throw new Refusal(refusal);
            }
        }
        if (depth!=0) throw new Refusal(refusal);
    }

    static Map<String,Object> rows(Prepared prepared,List<?> values,int maximum) {
        List<List<Object>> rows = new ArrayList<>();
        long bytes = 0;
        for (Object row : values) {
            if (rows.size()>=maximum) break;
            Object[] cells = row instanceof Object[] tuple ? tuple : new Object[]{row};
            if (cells.length!=prepared.columns().size()) throw new Refusal("unsupported_result_shape");
            List<Object> encoded = new ArrayList<>();
            for (int i=0;i<cells.length;i++) {
                Object value = cells[i];
                String expected = (String)prepared.columns().get(i).get("javaType");
                if (value!=null && !value.getClass().getName().equals(expected)) throw new Refusal("unsupported_result_shape");
                Object wire = value==null || value instanceof Boolean ? value : value.toString();
                if (wire instanceof String text) {
                    if (text.length()>4096) throw new Refusal("result_cell_limit");
                    bytes += 6L*text.getBytes(StandardCharsets.UTF_8).length+4;
                } else bytes+=8;
                if (bytes>MAX_RESULT_BYTES) throw new Refusal("result_payload_limit");
                encoded.add(wire);
            }
            rows.add(encoded);
        }
        Map<String,Object> response = new LinkedHashMap<>();
        response.put("state","executed"); response.put("columns",prepared.columns()); response.put("rows",rows);
        response.put("rowCount",rows.size()); response.put("hasMore",values.size()>maximum);
        response.put("queryExecuted",true); response.put("sqlExecuted",true); response.put("databaseReadOnlyTransaction",true);
        response.put("rolledBack",true); response.put("boundParameterValuesRetained",false);
        return response;
    }

    private static List<Map<String,Object>> descriptors(Object value,int limit) {
        if (!(value instanceof List<?> list) || list.size()>limit) throw new Refusal("query_model_limit");
        List<Map<String,Object>> out = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?,?> object)) throw new Refusal("unsupported_provider_metadata");
            Map<String,Object> accepted = new LinkedHashMap<>();
            for(String key: List.of("javaType","alias","name","position","multiValued"))
                if (object.containsKey(key)) accepted.put(key,object.get(key));
            out.add(accepted);
        }
        return out;
    }
}
