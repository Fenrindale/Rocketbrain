package fixture.boot;
import java.util.*;
import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.expression.spel.support.StandardEvaluationContext;
@Service
public class ProviderProbe {
    private final EntityManager em;
    private final ProviderArrayRepository repository;
    public ProviderProbe(EntityManager em,ProviderArrayRepository repository){this.em=em;this.repository=repository;}
    private String opaque(String choice) {
        var expressions=new SpelExpressionParser();var context=new StandardEvaluationContext();context.setVariable("choice",choice);
        return expressions.parseExpression("#choice == 'upper' ? 'select rb_upper(p.displayName) from Person p order by p.id' : 'select p.displayName from Person p order by p.id'").getValue(context,String.class);
    }
    @Transactional(readOnly=true) public Map<String,Object> probe(){
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("arrayValues",repository.byIds(new Long[]{1L,2L}));
        String dynamic=opaque("upper");result.put("opaqueQuery",dynamic);result.put("opaqueValues",em.createQuery(dynamic,String.class).getResultList());
        String window="select p.displayName, sum(p.id) filter (where p.id > 0) over (order by p.id) from Person p order by p.id";
        result.put("windowQuery",window);result.put("windowValues",em.createQuery(window,Object[].class).getResultList().stream().map(Arrays::asList).toList());
        String cte="with names as (select p.displayName as name, p.id as id from Person p) select n.name from names n order by n.id";
        result.put("cteQuery",cte);result.put("cteValues",em.createQuery(cte,String.class).getResultList());
        String union="select p.displayName from Person p union select d.name from Department d";
        result.put("unionQuery",union);result.put("unionValues",em.createQuery(union,String.class).getResultList());
        String derived="select d.name from (select p.displayName as name from Person p) d order by d.name";
        result.put("derivedQuery",derived);result.put("derivedValues",em.createQuery(derived,String.class).getResultList());
        return result;
    }
}
@RestController
class ProviderProbeController {
    private final ProviderProbe service;
    ProviderProbeController(ProviderProbe service){this.service=service;}
    @GetMapping("/probe/provider") public Map<String,Object> provider(){return service.probe();}
}
