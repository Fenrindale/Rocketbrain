package fixture.boot;

import fixture.contextchild.ContextChildRow;
import jakarta.annotation.PreDestroy;
import jakarta.persistence.EntityManagerFactory;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.http.HttpStatus;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.SharedEntityManagerCreator;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@ConditionalOnProperty(name="fixture.persistence-contexts.enabled",havingValue="true")
public class PersistenceContextsProbe {
    private final ConfigurableApplicationContext parent;
    private final DataSource dataSource;
    private final boolean transactionProbe;
    private GenericApplicationContext child;

    PersistenceContextsProbe(ConfigurableApplicationContext parent,DataSource dataSource,
        @Value("${fixture.jpa-transactions.enabled:false}") boolean transactionProbe){
        this.parent=parent;
        this.dataSource=dataSource;
        this.transactionProbe=transactionProbe;
    }

    @GetMapping("/probe/persistence-contexts/open")
    public synchronized Map<String,String> open(){
        if(child==null){
            var candidate=new GenericApplicationContext();
            candidate.setId("rocketbrain-persistence-child");
            candidate.setParent(parent);
            candidate.registerBean("entityManagerFactory",LocalContainerEntityManagerFactoryBean.class,this::factory);
            if(transactionProbe)candidate.registerBean("transactionManager",JpaTransactionManager.class,()->
                new JpaTransactionManager(candidate.getBean("entityManagerFactory",EntityManagerFactory.class)));
            try{candidate.refresh();child=candidate;}
            catch(RuntimeException failed){candidate.close();throw failed;}
        }
        return Map.of("parentId",parent.getId(),"childId",child.getId());
    }

    private LocalContainerEntityManagerFactoryBean factory(){
        var bean=new LocalContainerEntityManagerFactoryBean();
        bean.setPersistenceUnitName("rocketbrain-child-unit");
        bean.setPackagesToScan(ContextChildRow.class.getPackageName());
        bean.setMappingResources();
        bean.setDataSource(dataSource);
        bean.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
        bean.setJpaPropertyMap(Map.of("hibernate.hbm2ddl.auto","create-drop","hibernate.generate_statistics","true"));
        return bean;
    }

    @GetMapping("/probe/persistence-contexts/read")
    public synchronized Map<String,String> read(){
        if(child==null)throw new IllegalStateException("Open the child fixture first");
        try(var manager=child.getBean("entityManagerFactory",EntityManagerFactory.class).createEntityManager()){
            String result=manager.createQuery("select row.note from ContextChildRow row where row.id=:id",String.class)
                .setParameter("id",812548L).getSingleResult();
            return Map.of("child",result);
        }
    }

    @PostMapping("/probe/persistence-contexts/transactions/{operation}")
    public synchronized Map<String,Boolean> transactions(@PathVariable String operation){
        if(!transactionProbe||child==null)throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        var parentManager=parent.getBean("transactionManager",JpaTransactionManager.class);
        var parentEntityManager=SharedEntityManagerCreator.createSharedEntityManager(parentManager.getEntityManagerFactory());
        var main=new TransactionTemplate(parentManager);
        switch(operation){
            case "joined" -> main.executeWithoutResult(status->{
                write(parentEntityManager,91001L);
                main.executeWithoutResult(joined->write(parentEntityManager,91002L));
            });
            case "independent" -> main.executeWithoutResult(status->{
                write(parentEntityManager,91003L);
                var separate=new TransactionTemplate(parentManager);
                separate.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
                separate.executeWithoutResult(inner->write(parentEntityManager,91004L));
                status.setRollbackOnly();
            });
            case "child","conflict" -> {
                var childManager=child.getBean("transactionManager",JpaTransactionManager.class);
                var childEntityManager=SharedEntityManagerCreator.createSharedEntityManager(childManager.getEntityManagerFactory());
                var alternate=new TransactionTemplate(childManager);
                if(operation.equals("conflict")){
                    try{alternate.executeWithoutResult(status->childEntityManager.persist(new ContextChildRow(91005L,"private-fixture-duplicate")));}
                    catch(RuntimeException expected){return Map.of("complete",false);}
                    throw new IllegalStateException("Owned uniqueness control should have failed");
                }
                alternate.executeWithoutResult(status->write(childEntityManager,91005L));
            }
            case "read-only" -> {
                main.setReadOnly(true);
                main.executeWithoutResult(status->parentEntityManager.createNativeQuery("SELECT COUNT(*) FROM rb_context_child").getSingleResult());
            }
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return Map.of("complete",true);
    }

    private static void write(jakarta.persistence.EntityManager manager,long id){
        manager.createNativeQuery("INSERT INTO rb_context_child(id,note) VALUES (?1,?2)")
            .setParameter(1,id).setParameter(2,"private-fixture-transaction-value").executeUpdate();
    }

    @GetMapping("/probe/persistence-contexts/close")
    public synchronized Map<String,Boolean> closeChild(){
        shutdown();
        return Map.of("closed",true);
    }

    @PreDestroy
    synchronized void shutdown(){
        if(child!=null){child.close();child=null;}
    }
}
