package fixture.boot;
import java.util.*;
import jakarta.persistence.EntityManager;
import org.hibernate.Hibernate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
@Service
public class AdvancedProbeService {
    private final EntityManager em;
    private final PlatformTransactionManager manager;
    public AdvancedProbeService(EntityManager em,PlatformTransactionManager manager){this.em=em;this.manager=manager;}
    @Transactional(readOnly=true)
    public Map<String,Object> complexQueries(){
        Map<String,Object> result=new LinkedHashMap<>();
        var correlatedQuery=em.createQuery("""
                select p.displayName
                from Person p
                where exists (
                    select d.id from Department d
                    where d = p.department and d.name = :name
                )
                order by p.displayName
                """,String.class).setParameter("name","Engineering");
        result.put("correlatedExists",correlatedQuery.getResultList());
        result.put("compiledTextBlockQuery",correlatedQuery.unwrap(org.hibernate.query.Query.class).getQueryString());
        result.put("correlatedIn",em.createQuery("select p.displayName from Person p where p.department.id in (select d.id from Department d where d.id = p.department.id) order by p.displayName",String.class).getResultList());
        result.put("shadowedScopes",em.createQuery("select p.displayName from Person p where exists (select d.id from Department d where d = p.department and exists (select p.id from Department p where p.name = d.name)) order by p.displayName",String.class).getResultList());
        var groupedQuery=em.createQuery(
                ("select d.name, count(p), max(length(p.displayName)) " +
                 "from Person p join p.department d " +
                 "where lower(coalesce(p.displayName, '')) like :prefix " +
                 "group by d.name having count(p) >= 1 order by d.name"),
                Object[].class).setParameter("prefix","%");
        List<Object[]> grouped=groupedQuery.getResultList();
        result.put("compiledConcatenatedQuery",groupedQuery.unwrap(org.hibernate.query.Query.class).getQueryString());
        result.put("grouped",grouped.stream().map(Arrays::asList).toList());
        result.put("caseNames",em.createQuery("select case when p.address.city = 'Seoul' then upper(p.displayName) else lower(p.displayName) end from Person p order by p.displayName",String.class).getResultList());
        result.put("dto",em.createQuery("select new fixture.boot.PersonSummary(p.displayName, p.department.name) from Person p order by p.displayName",PersonSummary.class).getResultList());
        result.put("joinOn",em.createQuery("select p.displayName from Person p left join p.department d on d.name = :name where d.id is not null order by p.displayName",String.class).setParameter("name","Engineering").getResultList());
        Person fetched=em.createQuery("select p from Person p join fetch p.department where p.displayName = :name",Person.class).setParameter("name","Alex").getSingleResult();
        result.put("fetchInitialized",Hibernate.isInitialized(fetched.getDepartment()));
        result.put("collectionAlias",em.createQuery("select p.displayName from Department d join d.people p where p.address.city = :city order by p.displayName",String.class).setParameter("city","Seoul").getResultList());
        result.put("scalarCollectionAlias",em.createQuery("select t from CustomRecord c join c.tags t order by t",String.class).getResultList());
        result.put("treat",em.createQuery("select a.label from Asset a where treat(a as DocumentAsset).format = :format",String.class).setParameter("format","PDF").getResultList());
        result.put("xmlNamed",em.createNamedQuery("XmlEntry.byPrefix",XmlRecord.class).setParameter("prefix","XML%").getResultList().stream().map(XmlRecord::getLabel).toList());
        result.put("xmlOverride",em.createQuery("select x.label from XmlOverride x",String.class).getResultList());
        return result;
    }
    @Transactional(readOnly=true)
    public Map<String,Object> mappings(){
        Map<String,Object> result=new LinkedHashMap<>();
        CustomRecord record=em.createQuery("select c from CustomRecord c",CustomRecord.class).getSingleResult();
        result.put("nestedCity",record.getContact().getAddress().getCity());
        result.put("nestedPostal",record.getContact().getAddress().getPostalCode());
        result.put("nestedPhone",record.getContact().getPhoneNumber());
        result.put("overriddenDepartment",record.getAssignment().getDepartment().getName());
        result.put("convertedCode",record.getNormalizedCode());result.put("enumState",record.getState().name());
        result.put("secondaryNote",record.getNote());
        result.put("temporalDate",new java.text.SimpleDateFormat("yyyy-MM-dd").format(record.getRegisteredOn()));
        result.put("lobText",record.getLargeText());result.put("lobHex",HexFormat.of().formatHex(record.getRawData()));
        result.put("tags",record.getTags().stream().sorted().toList());
        result.put("joinDepartments",record.getDepartments().stream().map(Department::getName).sorted().toList());
        Warehouse warehouse=em.createQuery("select w from Warehouse w",Warehouse.class).getSingleResult();
        result.put("compositeJoin",Map.of("country",warehouse.getRegion().getId().getCountryCode(),"region",warehouse.getRegion().getId().getRegionCode(),"name",warehouse.getRegion().getName()));
        result.put("idClassLabel",em.find(License.class,new LicenseId("TENANT","PRO")).getLabel());
        Truck truck=em.createQuery("select t from Truck t",Truck.class).getSingleResult();
        result.put("joined",Map.of("name",truck.getName(),"payloadKg",truck.getPayloadKg()));
        CashPayment cash=em.find(CashPayment.class,700L);
        result.put("tablePerClass",Map.of("amount",cash.getAmount().toPlainString(),"register",cash.getRegisterCode()));
        result.put("xmlOnly",em.createNamedQuery("XmlEntry.byPrefix",XmlRecord.class).setParameter("prefix","XML%").getSingleResult().getLabel());
        return result;
    }
    public Map<String,Object> invalidQueries(){
        try {
            em.createQuery("select p.displayName from Person p where exists (select d.id from Department d where d.missingNested = p.department.name)",String.class).getResultList();
            return Map.of("invalidNestedPath","not rejected");
        } catch(RuntimeException error) {return Map.of("invalidNestedPath",error.getClass().getSimpleName());}
    }
    public Map<String,Object> bulkRollback(){
        Map<String,Object> result=new TransactionTemplate(manager).execute(status->{
            Map<String,Object> inside=new LinkedHashMap<>();
            int updated=em.createQuery("update Person p set p.displayName = concat(p.displayName, :suffix) where p.department in (select d from Department d where d.name = :name)").setParameter("suffix","-bulk").setParameter("name","Engineering").executeUpdate();
            em.clear();
            int deleted=em.createQuery("delete from Person p where p.displayName = :name").setParameter("name","Alex-bulk").executeUpdate();
            em.clear();
            inside.put("updated",updated);inside.put("deleted",deleted);
            inside.put("remainingInside",em.createQuery("select count(p) from Person p",Long.class).getSingleResult());
            status.setRollbackOnly();return inside;
        });
        result.put("afterRollbackNames",em.createQuery("select p.displayName from Person p order by p.displayName",String.class).getResultList());
        return result;
    }
}
