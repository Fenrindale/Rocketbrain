package rocketbrain.observer;

import java.util.List;
import java.util.Map;

public final class ConsoleQueryTest {
    private static final Map<String,Object> COLUMN = Map.of("javaType","java.lang.Long","alias","counter");

    public static void main(String[] arguments) {
        ConsoleQuery.inspect("select p.id from Person p where p.id >= :floor order by p.id",false);
        ConsoleQuery.inspect("select count(p1.id) from projects p1 where p1.id >= ? limit ?",true);
        ConsoleQuery.inspect("select p1.id from projects p1 where p1.id in (select p2.id from projects p2)",true);
        blocked("select database() from projects",true,"rendered_sql_not_allowed");
        blocked("select `database`() from projects",true,"rendered_sql_not_allowed");
        blocked("select _unverified(p1.id) from projects p1",true,"rendered_sql_not_allowed");
        blocked("select sample.lower(p1.label) from projects p1",true,"rendered_sql_not_allowed");
        blocked("select p1.id from projects p1 for update",true,"rendered_sql_not_allowed");
        blocked("select p1.id from projects p1 /* comment */",true,"rendered_sql_not_allowed");
        blocked("select p.id from Person p where p.name = 'example'",false,"unsupported_select_shape");

        var parameter = new ConsoleQuery.Parameter("floor",null,"java.lang.Long");
        var query = new ConsoleQuery.Prepared("select count(p.id) from Person p",List.of(COLUMN),List.of(parameter),Map.of());
        var bindings = ConsoleQuery.bind(query,Map.of(":floor","9223372036854775807"));
        if (!bindings.getFirst().value().equals(Long.MAX_VALUE)) throw new AssertionError("Precision was lost");
        refusal(()->ConsoleQuery.bind(query,Map.of(":floor","9223372036854775808")),"invalid_parameter_value");
        refusal(()->ConsoleQuery.bind(query,Map.of()),"parameter_keys_mismatch");
        var sample = ConsoleQuery.rows(query,List.of(1L,2L),1);
        if (!sample.get("rows").equals(List.of(List.of("1"))) || !Boolean.TRUE.equals(sample.get("hasMore")))
            throw new AssertionError("Result row cap or exact wire representation was lost");
    }

    private static void blocked(String query,boolean sql,String expected) {
        refusal(()->ConsoleQuery.inspect(query,sql),expected);
    }

    private static void refusal(Runnable action,String expected) {
        try { action.run(); }
        catch (ConsoleQuery.Refusal failure) {
            if (failure.code.equals(expected)) return;
            throw new AssertionError("Wrong refusal: " + failure.code);
        }
        throw new AssertionError("Expected a refusal: " + expected);
    }
}
