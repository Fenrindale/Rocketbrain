package rocketbrain.observer;

import static rocketbrain.observer.HibernateAccess.invoke;
import static rocketbrain.observer.HibernateAccess.javaType;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Checks each projected scalar branch against the live Hibernate shape before taking a JDBC lease. */
final class ConsoleSqmShape {
    private static final String SELECT = "org.hibernate.query.sqm.tree.select.";
    private static final String DOMAIN = "org.hibernate.query.sqm.tree.domain.";
    private int nodes;

    private record Projection(List<String> javaTypes,List<String> aliases) {}

    static void assertCompatible(Object statement) throws Throwable {
        if (statement==null || !statement.getClass().getName().equals(SELECT+"SqmSelectStatement"))
            throw new ConsoleQuery.Refusal("unsupported_provider_query_graph");
        new ConsoleSqmShape().container(statement,0,false);
    }

    private Projection container(Object container,int depth,boolean named) throws Throwable {
        bound(depth);
        for(Object cte:list(invoke(container,"getCteStatements"),12)) {
            Object definition=invoke(cte,"getCteDefinition");
            container(definition,depth+1,true);
        }
        Projection output=part(invoke(container,"getQueryPart"),depth+1);
        if (named) {
            Set<String> seen=new HashSet<>();
            for(String alias:output.aliases()) {
                if (alias==null || !alias.matches("[A-Za-z_][A-Za-z_0-9]{0,127}") || !seen.add(alias.toLowerCase(Locale.ROOT)))
                    throw new ConsoleQuery.Refusal("named_projection_required");
            }
        }
        return output;
    }

    private Projection part(Object part,int depth) throws Throwable {
        bound(depth);
        String actual=part.getClass().getName();
        if (actual.equals(SELECT+"SqmQueryGroup")) {
            Projection head=null;
            for (Object arm:list(invoke(part,"getQueryParts"),11)) {
                Projection next=part(arm,depth+1);
                if (head==null) head=next;
                else if(!head.javaTypes().equals(next.javaTypes())) throw new ConsoleQuery.Refusal("set_projection_mismatch");
            }
            if (head==null) throw new ConsoleQuery.Refusal("unsupported_provider_query_graph");
            return head;
        }
        if (!actual.equals(SELECT+"SqmQuerySpec")) throw new ConsoleQuery.Refusal("unsupported_provider_query_graph");
        for (Object root:list(invoke(invoke(part,"getFromClause"),"getRoots"),16)) from(root,depth+1);
        List<String> types=new ArrayList<>(),aliases=new ArrayList<>();
        for (Object item:list(invoke(invoke(part,"getSelectClause"),"getSelections"),ConsoleQuery.MAX_COLUMNS)) {
            String type=javaType(invoke(item,"getSelectableNode"));
            if (!ConsoleQuery.safeType(type)) throw new ConsoleQuery.Refusal("scalar_projection_required");
            types.add(type);
            Object alias=invoke(item,"getAlias");
            aliases.add(alias instanceof String text?text:null);
        }
        if(types.isEmpty()) throw new ConsoleQuery.Refusal("scalar_projection_required");
        return new Projection(types,aliases);
    }

    private void from(Object root,int depth) throws Throwable {
        bound(depth);
        String actual=root.getClass().getName();
        if (actual.equals(DOMAIN+"SqmDerivedRoot") || actual.equals(DOMAIN+"SqmDerivedJoin"))
            container(invoke(root,"getQueryPart"),depth+1,true);
        for (Object join:list(invoke(root,"getSqmJoins"),16)) from(join,depth+1);
    }

    private static Collection<?> list(Object value,int max) {
        if (!(value instanceof Collection<?> items) || items.size()>max)
            throw new ConsoleQuery.Refusal("query_model_limit");
        return items;
    }

    private void bound(int depth) {
        if (depth>20 || ++nodes>128) throw new ConsoleQuery.Refusal("query_model_limit");
    }
}
