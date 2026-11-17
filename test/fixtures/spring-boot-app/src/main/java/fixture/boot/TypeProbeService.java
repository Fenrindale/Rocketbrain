package fixture.boot;
import java.util.*;
import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.expression.spel.support.StandardEvaluationContext;
@Service
public class TypeProbeService {
    private final EntityManager em;
    private final TypedPersonRepository repository;
    public TypeProbeService(EntityManager em,TypedPersonRepository repository){this.em=em;this.repository=repository;}
    private static List<String> typeNames(Object[] values){return Arrays.stream(values).map(value->value==null?"null":value.getClass().getName()).toList();}
    @Transactional(readOnly=true)
    public Map<String,Object> validTypes(){
        Map<String,Object> result=new LinkedHashMap<>();
        Object[] aggregates=em.createQuery("select count(p), sum(p.id), avg(p.id), min(p.displayName), max(p.id) from Person p",Object[].class).getSingleResult();
        result.put("aggregateValues",Arrays.asList(aggregates));result.put("aggregateTypes",typeNames(aggregates));
        List<Object[]> numeric=em.createQuery("select p.id + 1, p.id + 0.5, case when p.id > 1 then p.id else 0L end, coalesce(p.displayName, 'none') from Person p order by p.id",Object[].class).getResultList();
        result.put("numericValues",numeric.stream().map(Arrays::asList).toList());result.put("numericTypes",typeNames(numeric.getFirst()));
        result.put("dto",em.createQuery("select new fixture.boot.TypedSummary(p.displayName, count(p)) from Person p group by p.displayName order by p.displayName",TypedSummary.class).getResultList());
        result.put("typedId",em.createQuery("select p.displayName from Person p where p.id = :id",String.class).setParameter("id",1L).getResultList());
        List<Long> ids=List.of(1L,2L);
        result.put("collection",em.createQuery("select p.displayName from Person p where p.id in :ids order by p.displayName",String.class).setParameter("ids",ids).getResultList());
        result.put("entity",em.createQuery("select p.displayName from Person p where p.department in (select d from Department d where d.name = :name) order by p.displayName",String.class).setParameter("name","Engineering").getResultList());
        return result;
    }
    @Transactional(readOnly=true)
    public Map<String,Object> dynamicQueries(boolean includeCity){
        Map<String,Object> result=new LinkedHashMap<>();
        final String local=TypeQueryParts.BASE+" where p.department.name = :department"+TypeQueryParts.ORDER;
        var localQuery=em.createQuery(local,String.class).setParameter("department","Engineering");
        result.put("constantQuery",localQuery.unwrap(org.hibernate.query.Query.class).getQueryString());result.put("constantNames",localQuery.getResultList());
        StringBuilder builder=new StringBuilder(TypeQueryParts.BASE);
        builder.append(" where p.address.city = :city");builder.append(TypeQueryParts.ORDER);
        var builderQuery=em.createQuery(builder.toString(),String.class).setParameter("city","Seoul");
        result.put("builderQuery",builderQuery.unwrap(org.hibernate.query.Query.class).getQueryString());result.put("builderNames",builderQuery.getResultList());
        final boolean known=true;
        final String chosen=TypeQueryParts.BASE+(known?" where p.displayName = :value":" where p.address.city = :value")+TypeQueryParts.ORDER;
        var chosenQuery=em.createQuery(chosen,String.class).setParameter("value","Alex");
        result.put("chosenQuery",chosenQuery.unwrap(org.hibernate.query.Query.class).getQueryString());result.put("chosenNames",chosenQuery.getResultList());
        final String finite=TypeQueryParts.BASE+(includeCity?" where p.address.city = :value":" where p.department.name = :value")+TypeQueryParts.ORDER;
        var finiteQuery=em.createQuery(finite,String.class).setParameter("value",includeCity?"Seoul":"Engineering");
        result.put("finiteQuery",finiteQuery.unwrap(org.hibernate.query.Query.class).getQueryString());result.put("finiteNames",finiteQuery.getResultList());
        return result;
    }
    @Transactional(readOnly=true)
    public Map<String,Object> spelQueries(){
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("named",repository.byFilter(new NameFilter("Alex","Seoul")));
        result.put("safeElvis",repository.bySafeFilter(null));
        result.put("indexed",repository.byIndexed(new NameFilter("Mina","Busan")));
        result.put("arithmetic",repository.above(0L));
        result.put("ternary",repository.byFallback(new NameFilter("Alex",null)));
        result.put("typedRepository",repository.byTypedId(1L));
        result.put("stringMethod",repository.byLower(new NameFilter("ALEX","Seoul")));
        return result;
    }
    private static String reject(Runnable action){try{action.run();return "accepted";}catch(RuntimeException error){return error.getClass().getSimpleName();}}
    public Map<String,Object> invalidTypes(){
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("arithmetic",reject(()->em.createQuery("select p.displayName + 1 from Person p").getResultList()));
        result.put("function",reject(()->em.createQuery("select length(p.id) from Person p").getResultList()));
        result.put("constructor",reject(()->em.createQuery("select new fixture.boot.TypedSummary(p.displayName, p.displayName) from Person p").getResultList()));
        result.put("entityComparison",reject(()->em.createQuery("select p from Person p where p.department = p.id").getResultList()));
        result.put("booleanPredicate",reject(()->em.createQuery("select p from Person p where p.displayName").getResultList()));
        result.put("subquery",reject(()->em.createQuery("select p from Person p where p.id in (select d.name from Department d)").getResultList()));
        result.put("resultClass",reject(()->em.createQuery("select p.displayName from Person p",Long.class).getResultList()));
        result.put("binding",reject(()->em.createQuery("select p from Person p where p.id = :id").setParameter("id","bad-id").getResultList()));
        result.put("assignment",reject(()->em.createQuery("update Person p set p.department = 'wrong'").unwrap(org.hibernate.query.Query.class).getQueryString()));
        return result;
    }
    // These annotations are deliberately outside a repository, so Spring Data
    // does not try to instantiate invalid query methods during application startup.
    @Query("select p.displayName from Person p where p.displayName = :#{#filter.missing}")
    public List<String> invalidSpelSource(@Param("filter") NameFilter filter){return List.of();}
    @Query("select p.displayName from Person p where p.displayName = :#{@unapprovedBean.lookup()}")
    public List<String> unsupportedSpelSource(){return List.of();}
    public Map<String,Object> spelErrors(){
        StandardEvaluationContext context=new StandardEvaluationContext();context.setVariable("filter",new NameFilter("Alex","Seoul"));
        SpelExpressionParser parser=new SpelExpressionParser();
        return Map.of("missingProperty",reject(()->parser.parseExpression("#filter.missing").getValue(context)));
    }
}
