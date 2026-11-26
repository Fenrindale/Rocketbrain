package fixture.boot;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinColumns;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.PersistenceContext;
import jakarta.persistence.Table;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class CompositeFetchProbe {
    @PersistenceContext
    private EntityManager entityManager;

    @GetMapping("/probe/hibernate-composite-fetch/lazy")
    @Transactional(readOnly=true)
    Map<String,Integer> lazy() {
        return inspect(entityManager.createQuery(
            "select o from CompositeFetchOwner o order by o.id.realm,o.id.number",CompositeFetchOwner.class).getResultList());
    }

    @GetMapping("/probe/hibernate-composite-fetch/join")
    @Transactional(readOnly=true)
    Map<String,Integer> joined() {
        return inspect(entityManager.createQuery(
            "select distinct o from CompositeFetchOwner o join fetch o.items order by o.id.realm,o.id.number",
            CompositeFetchOwner.class).getResultList());
    }

    @GetMapping("/probe/hibernate-composite-fetch/manual")
    @Transactional(readOnly=true)
    Map<String,Integer> manual() {
        List<CompositeFetchOwner> owners=entityManager.createQuery(
            "select o from CompositeFetchOwner o order by o.id.realm,o.id.number",CompositeFetchOwner.class).getResultList();
        int items=0;
        for(CompositeFetchOwner owner:owners){
            items+=entityManager.createQuery("select i.id from CompositeFetchItem i where i.owner.id=:ownerKey",Long.class)
                .setParameter("ownerKey",owner.id).getResultList().size();
        }
        return Map.of("owners",owners.size(),"items",items);
    }

    private Map<String,Integer> inspect(List<CompositeFetchOwner> owners) {
        int size=0;
        for(CompositeFetchOwner owner:owners)for(CompositeFetchItem item:owner.items)size++;
        return Map.of("owners",owners.size(),"items",size);
    }
}

@Embeddable
class CompositeFetchKey implements Serializable {
    @Column(name="owner_realm") String realm;
    @Column(name="owner_number") Long number;

    @Override public boolean equals(Object other) {
        return other instanceof CompositeFetchKey key && Objects.equals(realm,key.realm) && Objects.equals(number,key.number);
    }
    @Override public int hashCode() { return Objects.hash(realm,number); }
}

@Entity
@Table(name="rb_perf_composite_owner")
class CompositeFetchOwner {
    @EmbeddedId CompositeFetchKey id;

    @OneToMany(mappedBy="owner",fetch=FetchType.LAZY)
    List<CompositeFetchItem> items=new ArrayList<>();
}

@Entity
@Table(name="rb_perf_composite_item")
class CompositeFetchItem {
    @Id Long id;

    @ManyToOne(fetch=FetchType.LAZY)
    @JoinColumns({
        @JoinColumn(name="realm_ref",referencedColumnName="owner_realm",nullable=false),
        @JoinColumn(name="number_ref",referencedColumnName="owner_number",nullable=false)
    })
    CompositeFetchOwner owner;
}
