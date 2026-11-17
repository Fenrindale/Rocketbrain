package fixture.boot;
import jakarta.persistence.*;
import java.math.BigDecimal;
@Entity @Table(name="rb_v5_cash_payment")
public class CashPayment extends PaymentBase {
    @Column(name="register_code",length=30) private String registerCode;
    protected CashPayment() {}
    public CashPayment(Long id,BigDecimal amount,String registerCode){this.id=id;this.amount=amount;this.registerCode=registerCode;}
    public String getRegisterCode(){return registerCode;}
}
