package fixture.boot;

import fixture.contextchild.ContextChildRow;
import jakarta.annotation.PreDestroy;
import jakarta.persistence.EntityManagerFactory;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name="fixture.persistence-contexts.enabled",havingValue="true")
public class PersistenceContextsProbe {
    private final ConfigurableApplicationContext parent;
    private final DataSource dataSource;
    private GenericApplicationContext child;

    PersistenceContextsProbe(ConfigurableApplicationContext parent,DataSource dataSource){
        this.parent=parent;
        this.dataSource=dataSource;
    }

    @GetMapping("/probe/persistence-contexts/open")
    public synchronized Map<String,String> open(){
        if(child==null){
            var candidate=new GenericApplicationContext();
            candidate.setId("rocketbrain-persistence-child");
            candidate.setParent(parent);
            candidate.registerBean("entityManagerFactory",LocalContainerEntityManagerFactoryBean.class,this::factory);
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
