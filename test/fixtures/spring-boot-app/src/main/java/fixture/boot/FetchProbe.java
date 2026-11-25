package fixture.boot;

import jakarta.persistence.Entity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.PersistenceContext;
import jakarta.persistence.Table;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class FetchProbe {
    @PersistenceContext
    private EntityManager entityManager;

    @GetMapping("/probe/hibernate-fetch/lazy")
    @Transactional(readOnly=true)
    Map<String,Integer> lazy() {
        return count(entityManager.createQuery("select o from PerformanceOwner o order by o.id",PerformanceOwner.class).getResultList());
    }

    @GetMapping("/probe/hibernate-fetch/join")
    @Transactional(readOnly=true)
    Map<String,Integer> joined() {
        return count(entityManager.createQuery("select distinct o from PerformanceOwner o join fetch o.items order by o.id",PerformanceOwner.class).getResultList());
    }

    @GetMapping("/probe/hibernate-fetch/manual")
    @Transactional(readOnly=true)
    Map<String,Integer> manual() {
        List<PerformanceOwner> owners=entityManager.createQuery("select o from PerformanceOwner o order by o.id",PerformanceOwner.class).getResultList();
        int items=0;
        for(PerformanceOwner owner:owners){
            items+=entityManager.createQuery("select i.id from PerformanceItem i where i.owner.id=:key",Long.class)
                .setParameter("key",owner.id).getResultList().size();
        }
        return Map.of("owners",owners.size(),"items",items);
    }

    private Map<String,Integer> count(List<PerformanceOwner> owners) {
        int items=0;
        for(PerformanceOwner owner:owners)for(PerformanceItem item:owner.items)items++;
        return Map.of("owners",owners.size(),"items",items);
    }
}

@Entity
@Table(name="rb_perf_owner")
class PerformanceOwner {
    @Id Long id;
    @OneToMany(mappedBy="owner",fetch=FetchType.LAZY)
    List<PerformanceItem> items=new ArrayList<>();
}

@Entity
@Table(name="rb_perf_item")
class PerformanceItem {
    @Id Long id;
    @ManyToOne(fetch=FetchType.LAZY)
    @JoinColumn(name="owner_id",nullable=false)
    PerformanceOwner owner;
}
