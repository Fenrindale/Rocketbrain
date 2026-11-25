package fixture.boot;

import jakarta.annotation.PreDestroy;
import javax.sql.DataSource;
import org.hibernate.SessionFactory;
import org.hibernate.cfg.Configuration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "fixture.diagram.second-factory", havingValue = "true")
class RelationshipDiagramFixture {
    private final DataSource dataSource;
    private SessionFactory second;

    RelationshipDiagramFixture(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @EventListener(ApplicationReadyEvent.class)
    void start() {
        Configuration configuration = new Configuration().addAnnotatedClass(License.class);
        configuration.getProperties().put("hibernate.connection.datasource", dataSource);
        configuration.setProperty("hibernate.session_factory_name", "rocketbrain-diagram-secondary");
        configuration.setProperty("hibernate.session_factory_name_is_jndi", "false");
        configuration.setProperty("hibernate.hbm2ddl.auto", "none");
        second = configuration.buildSessionFactory();
    }

    @PreDestroy
    void stop() {
        if (second != null) second.close();
    }
}
