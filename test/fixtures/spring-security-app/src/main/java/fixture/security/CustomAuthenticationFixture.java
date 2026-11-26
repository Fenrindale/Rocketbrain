package fixture.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.InternalAuthenticationServiceException;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@Configuration(proxyBeanMethods=false)
@RestController
@ConditionalOnProperty(name="rb.fixture.custom-authentication",havingValue="true")
class CustomAuthenticationFixture {
    static final String REJECTION="fixture-private-provider-exception-message";
    private final JdbcClient jdbc;
    private final Environment environment;
    private final AtomicInteger skipChecks=new AtomicInteger(), abstentions=new AtomicInteger(), rejections=new AtomicInteger(),
        credentialCalls=new AtomicInteger(), parentCalls=new AtomicInteger(), reads=new AtomicInteger();
    private final CountDownLatch concurrentCredentials=new CountDownLatch(2);

    CustomAuthenticationFixture(JdbcClient jdbc,Environment environment){
        this.jdbc=jdbc;this.environment=environment;
    }
    @Bean @Order(0)
    SecurityFilterChain customAuthentication(HttpSecurity http)throws Exception {
        var manager=new ProviderManager(List.of(new SkippingProvider(),new AbstainingProvider(),new RejectingProvider(),new CredentialProvider()));
        return http.securityMatcher("/custom-authentication/**")
            .authenticationManager(manager)
            .authorizeHttpRequests(requests->requests.requestMatchers("/custom-authentication/counters").permitAll().anyRequest().authenticated())
            .httpBasic(Customizer.withDefaults()).build();
    }
    @Bean @Order(1)
    SecurityFilterChain delegatedAuthentication(HttpSecurity http)throws Exception {
        var manager=new ProviderManager(List.of(new AbstainingProvider()),new OpaqueParent());
        return http.securityMatcher("/custom-authentication-delegated")
            .authenticationManager(manager).authorizeHttpRequests(requests->requests.anyRequest().authenticated())
            .httpBasic(Customizer.withDefaults()).build();
    }
    @GetMapping({"/custom-authentication/data","/custom-authentication-delegated"})
    Map<String,Long> data(){
        reads.incrementAndGet();
        return Map.of("people",jdbc.sql("SELECT COUNT(*) FROM rb_spring_person").query(Long.class).single());
    }
    @GetMapping("/custom-authentication/counters")
    Map<String,Integer> counters(){
        return Map.of("skipChecks",skipChecks.get(),"abstentions",abstentions.get(),"rejections",rejections.get(),
            "credentials",credentialCalls.get(),"parent",parentCalls.get(),"reads",reads.get());
    }
    private Authentication check(Authentication input){
        String name=environment.getRequiredProperty("RB_SECURITY_REVIEWER"), pass=environment.getRequiredProperty("RB_SECURITY_REVIEWER_PASSWORD");
        if(!name.equals(input.getName())||!(input.getCredentials() instanceof String entered)||
            !MessageDigest.isEqual(pass.getBytes(StandardCharsets.UTF_8),entered.getBytes(StandardCharsets.UTF_8)))
            throw new BadCredentialsException(REJECTION);
        return UsernamePasswordAuthenticationToken.authenticated(name,null,AuthorityUtils.createAuthorityList("ROLE_FIXTURE_CUSTOM"));
    }
    private abstract static class BasicProvider implements AuthenticationProvider {
        @Override public boolean supports(Class<?> candidate){return candidate==UsernamePasswordAuthenticationToken.class;}
    }
    private final class SkippingProvider implements AuthenticationProvider {
        @Override public boolean supports(Class<?> candidate){skipChecks.incrementAndGet();return false;}
        @Override public Authentication authenticate(Authentication input){throw new AssertionError("Unsupported provider was called");}
    }
    private final class AbstainingProvider extends BasicProvider {
        @Override public Authentication authenticate(Authentication input){abstentions.incrementAndGet();return null;}
    }
    private final class RejectingProvider extends BasicProvider {
        @Override public Authentication authenticate(Authentication input){rejections.incrementAndGet();throw new BadCredentialsException(REJECTION);}
    }
    private final class CredentialProvider extends BasicProvider {
        @Override public Authentication authenticate(Authentication input){
            credentialCalls.incrementAndGet();concurrentCredentials.countDown();
            try{
                if(!concurrentCredentials.await(8,TimeUnit.SECONDS))throw new InternalAuthenticationServiceException("Fixture did not overlap two requests");
            }catch(InterruptedException interrupted){
                Thread.currentThread().interrupt();throw new InternalAuthenticationServiceException("Owned fixture interrupted");
            }
            if(environment.getRequiredProperty("RB_SECURITY_OPERATOR").equals(input.getName()))
                throw new InternalAuthenticationServiceException(REJECTION);
            return check(input);
        }
    }
    private final class OpaqueParent implements AuthenticationManager {
        @Override public Authentication authenticate(Authentication input){parentCalls.incrementAndGet();return check(input);}
    }
}
